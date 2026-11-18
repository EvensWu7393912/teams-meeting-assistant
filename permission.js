document.getElementById('go').addEventListener('click', async () => {
  const msg = document.getElementById('msg');
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    msg.textContent = '已授权，可以关掉这个页面了。';
  } catch (e) {
    msg.textContent = '没授权成功：' + (e.message || e) + '。可以在地址栏左边的图标里手动允许麦克风。';
  }
});
