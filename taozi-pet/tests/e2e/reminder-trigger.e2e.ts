import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchPackaged, quitGracefully, waitForWindows } from './helpers';

// 验证“提醒到点触发”新链路：notify 持续循环 + 提醒保留在列表，直到用户点击桌宠（ack）后才删除
async function main(): Promise<void> {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'pet-reminder-trigger-'));
  const application = await launchPackaged(userData);
  try {
    const windows = await waitForWindows(application);
    const { pet, dashboard } = windows;

    const saved = await dashboard.evaluate(() => window.petAPI!.reminders.save({
      text: 'TRIGGER TEST',
      dueAt: new Date(Date.now() + 3_000).toISOString(),
    }));
    console.log('[SAVED]', saved.id, saved.dueAt);

    // 等待桌宠进入 notify 状态
    const notifyReached = await pet.waitForFunction(
      () => document.getElementById('pet-container')?.dataset.state === 'notify',
      undefined,
      { timeout: 15_000 },
    ).then(() => true).catch(() => false);
    assert.equal(notifyReached, true, 'pet should enter notify state when reminder fires');
    console.log('[NOTIFY-STATE]', notifyReached);

    // 触发后提醒应仍保留在列表（点击后才删除）
    const listWhileNotifying = await dashboard.evaluate(() => window.petAPI!.reminders.list());
    assert.equal(
      listWhileNotifying.some((item) => item.id === saved.id),
      true,
      'reminder should remain listed until the user clicks the pet',
    );
    console.log('[REMAINING-WHILE-NOTIFYING]', listWhileNotifying.length);

    // 稍等片刻确认 notify 仍在循环（未被自动删除/自动回 idle）
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const stillNotifying = await pet.evaluate(() => document.getElementById('pet-container')?.dataset.state);
    assert.equal(stillNotifying, 'notify', 'notify should keep looping until the user clicks');
    console.log('[STILL-NOTIFYING]', stillNotifying);

    // 点击桌宠（消费提醒）
    await pet.evaluate(() => {
      const container = document.getElementById('pet-container');
      if (!container) throw new Error('pet container missing');
      container.click();
    });
    console.log('[CLICKED]');

    // 提醒应被删除
    const removed = await dashboard.waitForFunction(
      (id) => window.petAPI!.reminders.list().then((list) => !list.some((item) => item.id === id)),
      saved.id,
      { timeout: 5_000 },
    ).then(() => true).catch(() => false);
    assert.equal(removed, true, 'reminder should be removed after the pet is clicked');
    console.log('[REMOVED-AFTER-CLICK]', removed);

    await quitGracefully(application);
  } finally {
    await application.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
