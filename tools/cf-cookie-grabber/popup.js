const $ = (id) => document.getElementById(id);
let json = "";
let cfValue = "";

function setBadge(state, text) {
  const el = $("badge");
  el.className = "badge" + (state ? " " + state : "");
  el.textContent = text;
}

function setMsg(text, isErr) {
  const el = $("msg");
  el.textContent = text || "";
  el.className = isErr ? "err" : "";
}

function flash(btn, label) {
  const old = btn.dataset.label || btn.textContent;
  btn.dataset.label = old;
  btn.textContent = label;
  btn.classList.add("done");
  clearTimeout(btn._t);
  btn._t = setTimeout(() => {
    btn.textContent = old;
    btn.classList.remove("done");
  }, 1400);
}

function mask(v) {
  return v.length > 20 ? v.slice(0, 10) + "..." + v.slice(-6) : v;
}

function relExpiry(ts) {
  if (!ts) return "Session cookie, no expiry set.";
  const ms = ts * 1000 - Date.now();
  if (ms <= 0) return "Expired.";
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const when = d > 0 ? d + " d " + h + " h" : h + " h " + Math.floor((ms % 3600000) / 60000) + " min";
  return "Expires in " + when + ". Bound to this User-Agent and your IP.";
}

function showMissing(host, names) {
  setBadge("miss", "Not found");
  $("fields").hidden = true;
  $("copy").disabled = true;
  $("save").disabled = true;
  setMsg(
    "No cf_clearance for " + host + ". Cookies seen: " + (names || "none") +
      ". Pass the Cloudflare check in this tab, then Refresh. If this browser was never challenged, no cookie was issued; use the browser that passed it.",
    true
  );
}

async function load() {
  json = "";
  cfValue = "";
  setBadge("", "Checking");
  setMsg("");
  $("copy").disabled = true;
  $("save").disabled = true;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:/.test(tab.url || "")) {
    $("host").textContent = "No website tab";
    $("fields").hidden = true;
    setBadge("miss", "No site");
    setMsg("Open a website tab first.", true);
    return;
  }
  const url = new URL(tab.url);
  $("host").textContent = url.origin;

  // Query by url, domain, and CHIPS partition: cf_clearance may be partitioned.
  const seen = new Map();
  const add = (list) =>
    list.forEach((c) => seen.set(c.domain + c.path + c.name + JSON.stringify(c.partitionKey || {}), c));
  const host = url.hostname.split(".").slice(-2).join(".");
  const queries = [
    { url: tab.url },
    { domain: host },
    { url: tab.url, partitionKey: { topLevelSite: url.origin } },
    { domain: host, partitionKey: {} },
  ];
  for (const q of queries) {
    try { add(await chrome.cookies.getAll(q)); } catch (e) { /* option unsupported here */ }
  }
  const cookies = [...seen.values()];
  const cf = cookies.find((c) => c.name === "cf_clearance");
  if (!cf) return showMissing(host, cookies.map((c) => c.name).join(", "));

  cfValue = cf.value;
  json = JSON.stringify(
    {
      site: url.origin,
      cf_clearance: cf.value,
      ua: navigator.userAgent,
      expires: cf.expirationDate ? new Date(cf.expirationDate * 1000).toISOString() : null,
    },
    null,
    2
  );
  $("cfVal").textContent = mask(cf.value);
  $("uaVal").textContent = navigator.userAgent;
  $("uaVal").title = navigator.userAgent;
  $("expiry").textContent = relExpiry(cf.expirationDate);
  $("fields").hidden = false;
  $("copy").disabled = false;
  $("save").disabled = false;
  setBadge("ok", "Found");
  setMsg("Paste cf_clearance and User-Agent into the plugin's settings gear.");
}

async function copy(btn, text, label) {
  if (!text) return;
  await navigator.clipboard.writeText(text);
  flash(btn, label);
}

$("copyCf").onclick = (e) => copy(e.currentTarget, cfValue, "Copied");
$("copyUa").onclick = (e) => copy(e.currentTarget, cfValue && navigator.userAgent, "Copied");
$("copy").onclick = (e) => copy(e.currentTarget, json, "Copied");

$("save").onclick = (e) => {
  if (!json) return;
  const url = "data:application/json;charset=utf-8," + encodeURIComponent(json);
  chrome.downloads.download({ url, filename: "cf.json", saveAs: true }, () => {
    if (chrome.runtime.lastError) setMsg(chrome.runtime.lastError.message, true);
    else flash(e.currentTarget, "Saved");
  });
};

$("refresh").onclick = load;
load();
