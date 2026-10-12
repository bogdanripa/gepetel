// Like a password manager: a frame of its own next to a password field.
if (document.querySelector("input[type=password]")) {
  const f = document.createElement("iframe");
  f.src = chrome.runtime.getURL("frame.html");
  f.style.cssText = "position:fixed;right:8px;top:8px;width:200px;height:80px;border:1px solid #888";
  document.documentElement.appendChild(f);
}
