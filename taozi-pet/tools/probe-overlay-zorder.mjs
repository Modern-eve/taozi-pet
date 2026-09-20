// 诊断脚本：核对叠加层与桌宠在系统 z 序里的先后（Windows 专用，用 Win32 枚举真实层级）
// 用法：PET_SMOKE_CLIENT="tools/probe-overlay-zorder.mjs" node tools/run-dev.mjs --smoke
// 关注点：叠加层是同为置顶的全屏窗口，若排在桌宠之前，会因不接收激活而使桌宠点击后也抬不起来
import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const options = Object.fromEntries(process.argv.slice(2).map((entry) => entry.replace(/^--/, '').split('=')));
const port = Number(options.port || 9223);
const endpoint = `http://127.0.0.1:${port}`;
const dumpFile = path.join(process.cwd(), '.build', 'probe-zorder.txt');

const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$sig = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class ZOrder {
  [DllImport("user32.dll")] static extern IntPtr GetTopWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] static extern int GetWindowLongW(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  public static List<string> Dump() {
    var list = new List<string>();
    IntPtr h = GetTopWindow(IntPtr.Zero);
    int index = 0;
    while (h != IntPtr.Zero && index < 500) {
      StringBuilder sb = new StringBuilder(256);
      GetWindowTextW(h, sb, 256);
      string title = sb.ToString();
      if (title.Length > 0 && IsWindowVisible(h)) {
        int ex = GetWindowLongW(h, -20);
        list.Add(index + "\\t" + (((ex & 0x8) != 0) ? "TOPMOST" : "normal ") + "\\t" + title);
      }
      h = GetWindow(h, 2);
      index++;
    }
    return list;
  }
}
'@
Add-Type -TypeDefinition $sig
[ZOrder]::Dump() | Set-Content -LiteralPath '${dumpFile}' -Encoding utf8
`;

async function waitForTargets(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`${endpoint}/json/list`)).json();
      const pet = targets.find((item) => item.url.includes('/pet_window/'));
      const dashboard = targets.find((item) => item.url.includes('/dashboard_window/'));
      if (pet && dashboard) return { pet, dashboard };
    } catch {
      // 调试端点可能还没就绪
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('找不到桌宠与面板的调试目标');
}

async function evaluate(target, expression) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  return new Promise((resolve, reject) => {
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      socket.close();
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result?.result?.value);
    };
    socket.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }));
  });
}

/** 走 -EncodedCommand 避免多行脚本与中文路径的引号/编码问题，结果落文件再读，绕开控制台编码。 */
function dumpZOrder() {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { maxBuffer: 4 << 20 },
      (error) => (error ? reject(error) : resolve()),
    );
  }).then(async () => (await readFile(dumpFile, 'utf8')).replace(/^\uFEFF/, ''));
}

async function report(label) {
  const lines = (await dumpZOrder()).split(/\r?\n/).filter((line) => /桌宠|调试叠加层/.test(line));
  console.log(`\n=== ${label} ===`);
  console.log(lines.length ? lines.join('\n') : '(未找到相关窗口)');
}

const { dashboard } = await waitForTargets();
await report('开启叠加层之前');
await evaluate(dashboard, 'window.petAPI.settings.update({devMode:true})');
await evaluate(dashboard, 'window.petAPI.debug.setOverlay(true)');
await new Promise((resolve) => setTimeout(resolve, 1500));
await report('开启叠加层之后');
// 面板窗口非置顶，用它当「其他窗口」的参照物：桌宠若排到它后面，说明置顶已经失效
await evaluate(dashboard, 'window.petAPI.window.showDashboard()');
await new Promise((resolve) => setTimeout(resolve, 1200));
const all = (await dumpZOrder()).split(/\r?\n/).filter((line) => /桌宠|调试叠加层/.test(line));
console.log('\n=== 面板显示后（面板非置顶，应排在最后） ===');
console.log(all.length ? all.join('\n') : '(未找到相关窗口)');
await evaluate(dashboard, 'window.petAPI.settings.update({devMode:false})');
await rm(dumpFile, { force: true });
console.log('\n(编号越小越靠前；桌宠应排在调试叠加层与面板之前)');
