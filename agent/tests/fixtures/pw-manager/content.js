// Like a password manager: a frame of its own next to a password field,
// inside a closed shadow root (the hardest kind to reach), gone on Escape —
// and put back when something removes it, a few times (as iCloud Passwords
// does when a field gets focus again).
if (document.querySelector("input[type=password]")) {
  let puts = 0;
  const put = () => {
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "closed" });
    const f = document.createElement("iframe");
    f.src = chrome.runtime.getURL("frame.html");
    f.style.cssText = "position:fixed;right:8px;top:8px;width:200px;height:80px;border:1px solid #888";
    root.appendChild(f);
    document.documentElement.appendChild(host);
    puts++;
    let escaped = false;
    document.addEventListener("keydown", e => { if (e.key === "Escape") { escaped = true; host.remove(); } }, true);
    // Its frame taken out (not by Escape): back a moment later, up to 3 times.
    new MutationObserver(() => {
      if (!escaped && f.isConnected === false && puts < 4) { setTimeout(put, 800); escaped = true; }
    }).observe(root, { childList: true });
  };
  put();
}
