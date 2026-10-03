import os from 'node:os';

const VIRTUAL_IFACE = /virtualbox|vmware|vethernet|wsl|hyper-v|docker|vbox|loopback|tailscale|zerotier|bluetooth/i;

function score({ name, address }) {
  let s = 0;
  if (VIRTUAL_IFACE.test(name)) s -= 100;
  if (address.startsWith('192.168.56.')) s -= 50; // VirtualBox host-only default
  if (address.startsWith('192.168.')) s += 20;
  else if (address.startsWith('10.')) s += 10;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) s -= 10; // usually Docker/WSL
  if (/wi-?fi|wlan|wireless|ethernet|^en|^eth/i.test(name)) s += 15;
  return s;
}

/** Non-internal IPv4 addresses, most likely "real" LAN address first. */
export function lanAddresses() {
  return Object.entries(os.networkInterfaces())
    .flatMap(([name, list]) => (list || []).map((i) => ({ name, ...i })))
    .filter((i) => i.family === 'IPv4' && !i.internal)
    .sort((a, b) => score(b) - score(a))
    .map((i) => i.address);
}
