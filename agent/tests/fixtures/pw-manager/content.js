// Like a password manager: a frame of its own next to a password field, inside
// a closed shadow root (the hardest kind to reach), gone on Escape.
if (document.querySelector("input[type=password]")) {
  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "closed" });
  const f = document.createElement("iframe");
  f.src = chrome.runtime.getURL("frame.html");
  f.style.cssText = "position:fixed;right:8px;top:8px;width:200px;height:80px;border:1px solid #888";
  root.appendChild(f);
  document.documentElement.appendChild(host);
  document.addEventListener("keydown", e => { if (e.key === "Escape") host.remove(); }, true);
}
