// 看不见的录音页：拿到标签页音频流，（可选）混上自己的麦克风，用 MediaRecorder 录成 webm。

let recorder = null;
let chunks = [];
let streams = [];
let ctx = null;
let startedAt = 0;

function pad(n) {
  return String(n).padStart(2, '0');
}

function fileName(d) {
  return `Teams会议录音/${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.webm`;
}

async function start(streamId, withMic) {
  if (recorder) return { ok: true, recording: true, startedAt };

  const tabStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });
  streams = [tabStream];

  ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  const tabSrc = ctx.createMediaStreamSource(tabStream);
  tabSrc.connect(dest);
  tabSrc.connect(ctx.destination); // 抓取标签页声音后浏览器会静音该页，这里放回去，不然自己听不到

  let micNote = '';
  if (withMic) {
    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      streams.push(mic);
      ctx.createMediaStreamSource(mic).connect(dest);
    } catch (e) {
      micNote = '麦克风没授权，这次只录了会议里其他人的声音';
    }
  }

  chunks = [];
  recorder = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus' });
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: 'audio/webm' });
    const url = URL.createObjectURL(blob);
    chrome.runtime.sendMessage({ type: 'rec-done', url, startedAt, filename: fileName(new Date(startedAt)) });
    setTimeout(() => URL.revokeObjectURL(url), 10 * 60000); // 大文件写盘要时间，晚点再释放
    cleanup();
    broadcast();
  };
  // 标签页关了或流断了也要收尾
  tabStream.getAudioTracks()[0]?.addEventListener('ended', () => stop());

  recorder.start(1000);
  startedAt = Date.now();
  broadcast();
  return { ok: true, recording: true, startedAt, note: micNote };
}

function stop() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  return { ok: true, recording: false };
}

function cleanup() {
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  streams = [];
  ctx?.close();
  ctx = null;
  recorder = null;
}

function broadcast() {
  chrome.runtime.sendMessage({ type: 'rec-state', recording: !!recorder, startedAt }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'rec-start') {
    start(msg.streamId, msg.mic).then(sendResponse, (e) => {
      cleanup();
      sendResponse({ ok: false, error: String(e?.message || e) });
    });
    return true;
  }
  if (msg.type === 'rec-stop') sendResponse(stop());
  if (msg.type === 'rec-status') sendResponse({ ok: true, recording: !!recorder, startedAt });
});
