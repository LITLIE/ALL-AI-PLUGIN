// server/browser.mjs — 跨平台自动打开默认浏览器（零依赖）
// Windows: start "" URL
// macOS: open URL
// Linux: xdg-open URL

import { spawn } from 'node:child_process';
import os from 'node:os';

export function openBrowser(url) {
  const platform = os.platform();
  try {
    if (platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' });
    } else if (platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' });
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    }
  } catch (err) {
    console.warn(`[browser] failed to open: ${err.message}`);
  }
}
