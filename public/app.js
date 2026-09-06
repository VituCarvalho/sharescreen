const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const QUALITY_PRESETS = {
  low:    { width: 854,  height: 480,  maxBitrate: 1_000_000 },
  medium: { width: 1280, height: 720,  maxBitrate: 2_500_000 },
  high:   { width: 1920, height: 1080, maxBitrate: 5_000_000 },
  ultra:  { width: 3840, height: 2160, maxBitrate: 12_000_000 },
};

let selectedQuality = 'medium';
let selectedFps = 30;

let ws;
let localStream;
let peerConnections = new Map(); // viewerId -> RTCPeerConnection (host)
let peerConnection; // single connection (viewer)
let currentRoomId;
let viewerCount = 0;

// --- Elementos DOM ---
const homeScreen = document.getElementById('home-screen');
const hostScreen = document.getElementById('host-screen');
const viewerScreen = document.getElementById('viewer-screen');

const btnShare = document.getElementById('btn-share');
const btnJoin = document.getElementById('btn-join');
const btnStop = document.getElementById('btn-stop');
const btnLeave = document.getElementById('btn-leave');
const btnCopyCode = document.getElementById('btn-copy-code');
const btnFullscreen = document.getElementById('btn-fullscreen');

const roomCodeInput = document.getElementById('room-code');
const hostRoomCode = document.getElementById('host-room-code');
const viewerRoomCode = document.getElementById('viewer-room-code');
const viewerCountEl = document.getElementById('viewer-count');
const viewerStatus = document.getElementById('viewer-status');
const volumeSlider = document.getElementById('volume-slider');

const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');

// --- Navegação entre telas ---
function showScreen(screen) {
  [homeScreen, hostScreen, viewerScreen].forEach(s => s.classList.remove('active'));
  screen.classList.add('active');
}

// --- Toast ---
function showToast(msg) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

// --- WebSocket ---
function connectWS() {
  return new Promise((resolve, reject) => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}`);

    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('Erro ao conectar'));

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      handleMessage(msg);
    };

    ws.onclose = () => {
      // Se estava em uma sala, volta para home
      if (currentRoomId) {
        cleanup();
        showScreen(homeScreen);
        showToast('Conexão perdida');
      }
    };
  });
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// --- Mensagens recebidas ---
function handleMessage(msg) {
  switch (msg.type) {
    case 'room-created':
      currentRoomId = msg.roomId;
      hostRoomCode.textContent = msg.roomId;
      showScreen(hostScreen);
      break;

    case 'joined':
      currentRoomId = msg.roomId;
      viewerRoomCode.textContent = msg.roomId;
      showScreen(viewerScreen);
      viewerStatus.classList.add('show');
      viewerStatus.textContent = 'Aguardando transmissão...';
      break;

    case 'error':
      showToast(msg.message);
      break;

    // Host recebe: novo viewer entrou
    case 'viewer-joined':
      viewerCount++;
      viewerCountEl.textContent = `${viewerCount} assistindo`;
      createOfferForViewer(msg.viewerId);
      break;

    case 'viewer-left':
      viewerCount = Math.max(0, viewerCount - 1);
      viewerCountEl.textContent = `${viewerCount} assistindo`;
      const pc = peerConnections.get(msg.viewerId);
      if (pc) {
        pc.close();
        peerConnections.delete(msg.viewerId);
      }
      break;

    // Viewer recebe offer do host
    case 'offer':
      handleOffer(msg.offer);
      break;

    // Host recebe answer do viewer
    case 'answer':
      handleAnswer(msg.answer, msg.viewerId);
      break;

    // ICE candidates
    case 'ice-candidate':
      handleIceCandidate(msg.candidate, msg.viewerId);
      break;

    case 'host-left':
      cleanup();
      showScreen(homeScreen);
      showToast('O host parou de compartilhar');
      break;
  }
}

// --- HOST: Compartilhar tela ---
async function startSharing() {
  try {
    const preset = QUALITY_PRESETS[selectedQuality];
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        cursor: 'always',
        width: { ideal: preset.width },
        height: { ideal: preset.height },
        frameRate: { ideal: selectedFps },
      },
      audio: true,
    });

    localVideo.srcObject = localStream;

    // Se o usuário parar o compartilhamento pelo botão nativo do navegador
    localStream.getVideoTracks()[0].onended = () => {
      stopSharing();
    };

    const qualityLabels = { low: '480p', medium: '720p', high: '1080p', ultra: '4K' };
    document.getElementById('host-quality-badge').textContent =
      `${qualityLabels[selectedQuality]} ${selectedFps}fps`;

    await connectWS();
    send({ type: 'create-room' });
  } catch (err) {
    if (err.name !== 'NotAllowedError') {
      showToast('Erro ao capturar tela: ' + err.message);
    }
  }
}

function stopSharing() {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  localVideo.srcObject = null;

  peerConnections.forEach(pc => pc.close());
  peerConnections.clear();
  viewerCount = 0;

  if (ws) ws.close();
  currentRoomId = null;
  showScreen(homeScreen);
}

// HOST: Cria offer para um viewer específico
async function createOfferForViewer(viewerId) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peerConnections.set(viewerId, pc);

  // Adiciona tracks da tela (video + audio) ao peer connection
  if (localStream) {
    localStream.getTracks().forEach(track => {
      pc.addTrack(track, localStream);
    });
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      send({ type: 'ice-candidate', candidate: event.candidate, viewerId });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      pc.close();
      peerConnections.delete(viewerId);
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // Limitar bitrate do vídeo
  const preset = QUALITY_PRESETS[selectedQuality];
  const senders = pc.getSenders();
  for (const sender of senders) {
    if (sender.track && sender.track.kind === 'video') {
      const params = sender.getParameters();
      if (!params.encodings) params.encodings = [{}];
      params.encodings[0].maxBitrate = preset.maxBitrate;
      await sender.setParameters(params);
    }
  }

  send({ type: 'offer', offer, viewerId });
}

// --- VIEWER: Entrar na sala ---
async function joinRoom() {
  const code = roomCodeInput.value.trim().toUpperCase();
  if (code.length < 4) {
    showToast('Digite o código da sala');
    return;
  }

  try {
    await connectWS();
    send({ type: 'join-room', roomId: code });
  } catch {
    showToast('Erro ao conectar ao servidor');
  }
}

// VIEWER: Recebe offer e envia answer
async function handleOffer(offer) {
  peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      send({ type: 'ice-candidate', candidate: event.candidate });
    }
  };

  peerConnection.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
    viewerStatus.classList.remove('show');
  };

  peerConnection.onconnectionstatechange = () => {
    if (peerConnection.connectionState === 'connected') {
      viewerStatus.classList.remove('show');
    } else if (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed') {
      viewerStatus.textContent = 'Conexão perdida';
      viewerStatus.classList.add('show');
    }
  };

  await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  send({ type: 'answer', answer });
}

// HOST: Recebe answer do viewer
async function handleAnswer(answer, viewerId) {
  const pc = peerConnections.get(viewerId);
  if (pc) {
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
  }
}

// Ambos: ICE candidate
async function handleIceCandidate(candidate, viewerId) {
  try {
    if (viewerId && peerConnections.has(viewerId)) {
      // Host recebe candidate do viewer
      await peerConnections.get(viewerId).addIceCandidate(new RTCIceCandidate(candidate));
    } else if (peerConnection) {
      // Viewer recebe candidate do host
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
  } catch {
    // ICE candidate pode falhar se a conexão já foi encerrada
  }
}

function cleanup() {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  localVideo.srcObject = null;
  remoteVideo.srcObject = null;

  peerConnections.forEach(pc => pc.close());
  peerConnections.clear();

  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  viewerCount = 0;
  currentRoomId = null;
}

// --- Event Listeners ---
btnShare.addEventListener('click', startSharing);

btnJoin.addEventListener('click', joinRoom);

roomCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinRoom();
});

btnStop.addEventListener('click', stopSharing);

btnLeave.addEventListener('click', () => {
  cleanup();
  if (ws) ws.close();
  showScreen(homeScreen);
});

btnCopyCode.addEventListener('click', () => {
  navigator.clipboard.writeText(currentRoomId).then(() => {
    showToast('Código copiado!');
  });
});

btnFullscreen.addEventListener('click', () => {
  const container = remoteVideo.parentElement;
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    container.requestFullscreen();
  }
});

volumeSlider.addEventListener('input', (e) => {
  remoteVideo.volume = e.target.value / 100;
});

// Quality & FPS selectors
document.querySelectorAll('.quality-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.quality-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedQuality = btn.dataset.quality;
  });
});

document.querySelectorAll('.fps-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.fps-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedFps = parseInt(btn.dataset.fps);
  });
});
