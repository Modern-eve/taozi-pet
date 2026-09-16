import test from 'node:test';
import assert from 'node:assert/strict';
import type { IdleRotationGapLevelSpec, IdleRotationSpec, PetState } from '../../src/shared/contracts';
import { PetStateMachine } from '../../src/renderer/pet/state-machine';

function state(id: string, overrides: Partial<PetState> = {}): PetState {
  return {
    id,
    triggers: [],
    frames: [`${id}-1.png`, `${id}-2.png`],
    frameDurationMs: 100,
    loop: false,
    canInterrupt: [],
    interrupt: 'restart',
    cooldownMs: 0,
    direction: 'neutral',
    anchor: { x: 0.5, y: 0.95 },
    mirrorSafe: true,
    ...overrides,
  };
}

// 一个呼吸的时长（对应 spec.motion.breathing.periodMs），测试里取小值方便断言；
// 间歇时长 = 呼吸次数 × 该周期，测试里次数取固定值（min === max）以便断言
const BREATH_MS = 50;
const GAP_LEVELS: IdleRotationGapLevelSpec[] = [
  { minBreaths: 10, maxBreaths: 10 }, // 0 木头人 → 500ms
  { minBreaths: 4, maxBreaths: 4 },   // 1 散步 → 200ms
  { minBreaths: 3, maxBreaths: 3 },   // 2 正常 → 150ms
  { minBreaths: 2, maxBreaths: 2 },   // 3 活泼 → 100ms
  { minBreaths: 1, maxBreaths: 1 },   // 4 多动症 → 50ms
];

function rotation(entries: Array<[string, number]>): IdleRotationSpec {
  return {
    states: entries.map(([id, weight]) => ({ id, weight })),
    gap: { stateId: 'standby-gap', levels: GAP_LEVELS },
  };
}

// 待机轮播动作：单轮 2 帧 × 100ms = 200ms；间歇状态：单帧静态帧
const look = state('look', { interrupt: 'resume' });
const blink = state('blink');
const gap = state('standby-gap', { frames: ['core-ip.png'], interrupt: 'resume' });
const standby = rotation([['look', 1], ['blink', 1]]);
const STANDBY_IDS = ['look', 'blink'];

test('进入待机时从轮播池中挑一个动作播放', () => {
  const machine = new PetStateMachine([look, blink, gap], standby, 0, BREATH_MS);
  assert.ok(STANDBY_IDS.includes(machine.currentStateId()));
  assert.equal(machine.isStandby(), true);
});

test('轮播动作播完进入间歇，间歇结束续接下一个轮播动作', () => {
  const machine = new PetStateMachine([look, gap], rotation([['look', 1]]), 0, BREATH_MS);
  machine.setWalkLevel(1); // 间歇 200ms
  assert.equal(machine.tick(0).frameIndex, 0);
  assert.equal(machine.tick(100).frameIndex, 1);
  assert.equal(machine.tick(199).stateId, 'look');
  // 单轮播完 → 间歇（展示静态帧，帧号停在唯一一帧）
  const during = machine.tick(200);
  assert.equal(during.stateChanged, true);
  assert.equal(during.stateId, 'standby-gap');
  assert.equal(during.frame, 'core-ip.png');
  assert.equal(during.frameIndex, 0);
  assert.equal(machine.isStandby(), true);
  // 间歇未走完仍停在静态帧，走完后回到轮播动作
  assert.equal(machine.tick(399).stateId, 'standby-gap');
  assert.equal(machine.tick(400).stateId, 'look');
});

test('间歇长度取自当前随机行走挡位（呼吸次数 × 呼吸周期）', () => {
  const machine = new PetStateMachine([look, gap], rotation([['look', 1]]), 0, BREATH_MS);
  machine.setWalkLevel(4); // 1 次呼吸 = 50ms
  machine.tick(200);
  assert.equal(machine.currentStateId(), 'standby-gap');
  assert.equal(machine.tick(249).stateId, 'standby-gap');
  assert.equal(machine.tick(250).stateId, 'look');
});

test('间歇时长恒为呼吸周期的整数倍，且落在该挡位的呼吸次数区间内', () => {
  // 区间随机：间歇结束时刻必然对齐呼吸周期，呼吸动画不会在半相位被摘掉
  const levels: IdleRotationGapLevelSpec[] = [
    { minBreaths: 4, maxBreaths: 6 },
    { minBreaths: 3, maxBreaths: 5 },
    { minBreaths: 2, maxBreaths: 4 },
    { minBreaths: 1, maxBreaths: 3 },
    { minBreaths: 1, maxBreaths: 2 },
  ];
  const spec: IdleRotationSpec = { states: [{ id: 'look', weight: 1 }], gap: { stateId: 'standby-gap', levels } };
  for (let level = 0; level < levels.length; level += 1) {
    const { minBreaths, maxBreaths } = levels[level]!;
    for (let round = 0; round < 12; round += 1) {
      const machine = new PetStateMachine([look, gap], spec, 0, BREATH_MS);
      machine.setWalkLevel(level);
      machine.tick(200); // 单轮播完，进入间歇
      assert.equal(machine.currentStateId(), 'standby-gap');
      let gapMs = -1;
      const deadline = 200 + maxBreaths * BREATH_MS + 5;
      for (let t = 201; t <= deadline; t += 1) {
        if (machine.tick(t).stateId !== 'standby-gap') { gapMs = t - 200; break; }
      }
      assert.notEqual(gapMs, -1, `挡位 ${level} 的间歇未在 ${maxBreaths} 次呼吸内结束`);
      assert.equal(gapMs % BREATH_MS, 0, `挡位 ${level} 间歇 ${gapMs}ms 不是呼吸周期的整数倍`);
      const breaths = gapMs / BREATH_MS;
      assert.ok(
        breaths >= minBreaths && breaths <= maxBreaths,
        `挡位 ${level} 间歇 ${breaths} 次呼吸不在 [${minBreaths}, ${maxBreaths}] 内`,
      );
    }
  }
});

test('挡位越界时退回第 0 档（最长间歇）', () => {
  const machine = new PetStateMachine([look, gap], rotation([['look', 1]]), 0, BREATH_MS);
  machine.setWalkLevel(99);
  machine.tick(200);
  assert.equal(machine.tick(699).stateId, 'standby-gap');
  assert.equal(machine.tick(700).stateId, 'look');
});

test('池内互斥：轮播动作之间互不打断', () => {
  const machine = new PetStateMachine([look, blink, gap], standby, 0, BREATH_MS);
  const current = machine.currentStateId();
  const other = current === 'look' ? 'blink' : 'look';
  assert.equal(machine.start(other, 10), false);
  assert.equal(machine.currentStateId(), current);
  // 间歇不属于池内互斥：待机动作可以在间歇期接管
  machine.tick(200);
  assert.equal(machine.currentStateId(), 'standby-gap');
  assert.equal(machine.start(current, 210), true);
  assert.equal(machine.currentStateId(), current);
});

test('待机是抢占基底：轮播动作与间歇都能被任意状态打断', () => {
  const happy = state('happy', { canInterrupt: [] });
  const onAction = new PetStateMachine([look, gap, happy], rotation([['look', 1]]), 0, BREATH_MS);
  assert.equal(onAction.start('happy', 10, 500), true);
  assert.equal(onAction.currentStateId(), 'happy');

  const onGap = new PetStateMachine([look, gap, happy], rotation([['look', 1]]), 0, BREATH_MS);
  onGap.tick(200); // 播完进入间歇
  assert.equal(onGap.currentStateId(), 'standby-gap');
  assert.equal(onGap.start('happy', 210, 500), true);
  assert.equal(onGap.currentStateId(), 'happy');
});

test('一次性状态播完后不进入间歇，直接续接轮播动作', () => {
  const play = state('play');
  const machine = new PetStateMachine([look, gap, play], rotation([['look', 1]]), 0, BREATH_MS);
  assert.equal(machine.start('play', 0), true);
  assert.equal(machine.tick(199).stateId, 'play');
  const after = machine.tick(200);
  assert.equal(after.stateChanged, true);
  assert.ok(STANDBY_IDS.includes(after.stateId));
});

test('非待机状态之间按名单打断，同状态按 interrupt 生效', () => {
  const busy = state('busy');
  const restart = state('restart', { canInterrupt: ['busy'], interrupt: 'restart' });
  const resume = state('resume', { canInterrupt: ['busy', 'restart'], interrupt: 'resume' });
  const machine = new PetStateMachine([look, gap, busy, restart, resume], rotation([['look', 1]]), 0, BREATH_MS);
  assert.equal(machine.start('busy', 0, 500), true); // 待机可被任意状态抢占
  assert.equal(machine.start('restart', 10, 500), true); // restart 的名单含 busy
  assert.equal(machine.start('restart', 20, 500), true); // 同状态 interrupt=restart 可重入
  assert.equal(machine.start('resume', 30, 500), true); // resume 的名单含 restart
  assert.equal(machine.start('resume', 40, 500), false); // 同状态 interrupt=resume 不可重入
  assert.equal(machine.start('busy', 50, 500), false); // busy 名单不含 resume，无法打断
});

test('通配符名单可打断任意状态', () => {
  const action = state('notify', { canInterrupt: ['*'] });
  const busy = state('busy');
  const machine = new PetStateMachine([look, gap, busy, action], rotation([['look', 1]]), 0, BREATH_MS);
  machine.start('busy', 0, 500);
  assert.equal(machine.start('notify', 10), true);
});

test('cooldown 自状态完成时开始计时', () => {
  const action = state('action', { cooldownMs: 300 });
  const machine = new PetStateMachine([look, gap, action], rotation([['look', 1]]), 0, BREATH_MS);
  machine.start('action', 0, 100);
  machine.tick(100);
  assert.equal(machine.start('action', 399), false);
  assert.equal(machine.start('action', 400), true);
});

test('权重为 0 的成员不参与轮播', () => {
  const machine = new PetStateMachine([look, blink, gap], rotation([['look', 1], ['blink', 0]]), 0, BREATH_MS);
  for (let i = 1; i <= 20; i += 1) machine.startStandby(i * 1000);
  assert.equal(machine.currentStateId(), 'look');
});

test('轮播池无有效成员时构造失败', () => {
  assert.throws(() => new PetStateMachine([look, gap], rotation([]), 0, BREATH_MS), /idleRotation/);
});
