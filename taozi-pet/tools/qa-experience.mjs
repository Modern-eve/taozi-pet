import { makeCheck, runChecks, loadSpec } from './qa-common.mjs';

const spec = await loadSpec();

const stateById = new Map(spec.states.map((state) => [state.id, state]));
// 待机轮播池成员：待机时按权重随机单轮播放，播完进入间歇、再续接下一个
const standbyIds = new Set((spec.idleRotation?.states ?? []).map((entry) => entry.id));
// 待机基底 = 轮播动作 + 间歇状态：都由轮播调度直接进入，也都能被任意状态抢占
const gapStateId = spec.idleRotation?.gap?.stateId;
const standbyBaseIds = new Set(gapStateId ? [...standbyIds, gapStateId] : standbyIds);
const triggerOwners = new Map();
for (const state of spec.states) {
  for (const trigger of state.triggers ?? []) {
    if (!triggerOwners.has(trigger)) triggerOwners.set(trigger, state.id);
  }
}

const checks = [];

// ---- interrupt-matrix（canInterrupt 名单完整性） ----
checks.push(makeCheck({
  id: 'caninterrupt-id-exists',
  gate: 'interrupt-matrix',
  describe: 'canInterrupt 引用的每个状态 id 必须存在于 states 中',
  run: () => {
    const bad = [];
    for (const state of spec.states) {
      for (const target of state.canInterrupt ?? []) {
        if (target !== '*' && !stateById.has(target)) bad.push(`${state.id} -> ${target}`);
      }
    }
    return { passed: bad.length === 0, detail: bad.length ? `引用不存在状态: ${bad.join('; ')}` : '全部合法' };
  },
}));

checks.push(makeCheck({
  id: 'caninterrupt-live-lock',
  gate: 'interrupt-matrix',
  severity: 'warning',
  describe: '常驻状态（循环播放或定格末帧）无「逃生门」（不被任何其它状态能打断）才判定卡死',
  run: () => {
    // 判定：一个常驻状态要能自拔出，必须有另一个状态（含 * 通配）能打断它。
    // 只凭自身 loop+'*' 并不构成死锁——能被 happy/互动等打断即可安全退出，需反向推演。
    // 待机基底（轮播动作与间歇）由状态机自行调度，不依赖被谁打断，故不参与此判定。
    const stuck = [];
    for (const state of spec.states) {
      if (standbyBaseIds.has(state.id) || !(state.loop || state.holdLastFrame)) continue;
      const escapedBy = spec.states.find((other) =>
        other.id !== state.id && ((other.canInterrupt ?? []).includes('*') || (other.canInterrupt ?? []).includes(state.id))
      );
      if (!escapedBy) stuck.push(`${state.id}`);
    }
    return {
      passed: stuck.length === 0,
      detail: stuck.length
        ? `${stuck.join(', ')} 为常驻状态且无任何状态能打断它：一旦进入将无法回待机，请补充一个可打断它的状态，或改为有限时长`
        : '所有常驻状态都有逃生门（可被其它状态打断回待机）',
    };
  },
}));

checks.push(makeCheck({
  id: 'caninterrupt-standby-redundant',
  gate: 'interrupt-matrix',
  severity: 'warning',
  describe: '名单含待机基底（轮播动作或间歇）属冗余（待机本就可被任意状态抢占）',
  run: () => {
    const redundant = spec.states
      .filter((state) => !standbyBaseIds.has(state.id) && (state.canInterrupt ?? []).some((target) => standbyBaseIds.has(target)))
      .map((state) => state.id);
    return { passed: redundant.length === 0, detail: redundant.length ? `可移除待机状态的状态: ${redundant.join(', ')}` : '无冗余' };
  },
}));

checks.push(makeCheck({
  id: 'caninterrupt-covering',
  gate: 'interrupt-matrix',
  severity: 'warning',
  describe: '每个非待机状态都至少被一个其它状态可打断（防被遗忘孤立）',
  run: () => {
    const overlooked = spec.states
      .filter((state) => !standbyBaseIds.has(state.id))
      .filter((state) => !spec.states.some((other) => other.id !== state.id && ((other.canInterrupt ?? []).includes('*') || (other.canInterrupt ?? []).includes(state.id))))
      .map((state) => state.id);
    return { passed: overlooked.length === 0, detail: overlooked.length ? `无人可打断: ${overlooked.join(', ')}` : '所有状态均有 back-reach' };
  },
}));

// ---- interaction ----
checks.push(makeCheck({
  id: 'interaction-connected',
  gate: 'interaction',
  describe: '菜单动作的 trigger 与互动状态的 stateId 连通',
  run: () => {
    const broken = [];
    for (const interaction of spec.experience.interactions ?? []) {
      if (triggerOwners.get(`interaction:${interaction.id}`) !== interaction.stateId) broken.push(`${interaction.id}: trigger 与 stateId 未连通`);
    }
    return { passed: broken.length === 0, detail: broken.length ? broken.join('; ') : '全部连通' };
  },
}));

// ---- motion ----
checks.push(makeCheck({
  id: 'interaction-frames-min',
  gate: 'motion',
  describe: '每个互动状态的去重帧数 ≥ 6',
  run: () => {
    const weak = [];
    for (const interaction of spec.experience.interactions ?? []) {
      const state = stateById.get(interaction.stateId);
      if (state) {
        const unique = new Set(state.frames).size;
        if (unique < 6) weak.push(`${interaction.stateId}(${unique})`);
      }
    }
    return { passed: weak.length === 0, detail: weak.length ? `帧数不足: ${weak.join(', ')}` : '全部 ≥6' };
  },
}));

checks.push(makeCheck({
  id: 'motion-procedural',
  gate: 'motion',
  describe: 'breathing / squashStretch 至少启用一项',
  run: () => {
    const breathing = Boolean(spec.motion?.breathing?.enabled);
    const squash = Boolean(spec.motion?.squashStretch?.enabled);
    return { passed: breathing || squash, detail: `breathing:${breathing} squashStretch:${squash}` };
  },
}));

// 待机间歇随挡位单向：挡位越高越活跃，间歇呼吸次数不应反向变多（0 木头人最长）
checks.push(makeCheck({
  id: 'standby-gap-monotonic',
  gate: 'motion',
  severity: 'warning',
  describe: '待机间歇呼吸次数随挡位不反向变多',
  run: () => {
    const levels = spec.idleRotation?.gap?.levels ?? [];
    const bad = [];
    for (let index = 1; index < levels.length; index += 1) {
      if (levels[index].minBreaths > levels[index - 1].minBreaths || levels[index].maxBreaths > levels[index - 1].maxBreaths) bad.push(`挡位 ${index - 1}→${index}`);
    }
    return { passed: bad.length === 0, detail: bad.length ? `间歇反向变长: ${bad.join(', ')}` : '间歇随挡位单调不变长' };
  },
}));

// ---- walk（随机行走挡位：spec 默认值的内部一致性） ----
checks.push(makeCheck({
  id: 'walk-levels-shape',
  gate: 'motion',
  describe: 'walk.levels 为 5 档、0 档木头人、各档区间/位移/半径自洽',
  run: () => {
    const walk = spec.motion?.walk ?? {};
    const levels = walk.levels ?? [];
    const problems = [];
    if (levels.length !== 5) problems.push(`levels 长度 ${levels.length}≠5`);
    if (levels[0] !== null) problems.push('0 档应为木头人（null）');
    for (let index = 1; index < levels.length; index += 1) {
      const level = levels[index] ?? {};
      if (!(level.intervalMin <= level.intervalMax)) problems.push(`挡位 ${index} 间隔区间倒置`);
      if (!(level.distMin <= level.distMax)) problems.push(`挡位 ${index} 位移区间倒置`);
      if (!(level.distMax <= level.range)) problems.push(`挡位 ${index} 位移超过游走半径`);
    }
    return { passed: problems.length === 0, detail: problems.length ? problems.join('; ') : '5 档结构自洽' };
  },
}));

// 挡位越高越勤、越远（用户可感知的排序语义，不应被调参调反）
checks.push(makeCheck({
  id: 'walk-levels-monotonic',
  gate: 'motion',
  severity: 'warning',
  describe: '挡位越高：游走间隔不变长、半径与单次位移不变小',
  run: () => {
    const levels = spec.motion?.walk?.levels ?? [];
    const bad = [];
    for (let index = 2; index < levels.length; index += 1) {
      const previous = levels[index - 1];
      const current = levels[index];
      if (!previous || !current) continue;
      if (current.intervalMax > previous.intervalMax) bad.push(`挡位 ${index - 1}→${index} 间隔变长`);
      if (current.distMax < previous.distMax) bad.push(`挡位 ${index - 1}→${index} 位移变小`);
      if (current.range < previous.range) bad.push(`挡位 ${index - 1}→${index} 半径变小`);
    }
    return { passed: bad.length === 0, detail: bad.length ? bad.join('; ') : '挡位越高越勤越远' };
  },
}));

// ---- quotes（语录一致性） ----
checks.push(makeCheck({
  id: 'quote-sync',
  gate: 'quotes',
  describe: '状态语录与互动反馈语录均非空（每组 ≥1 条）',
  run: () => {
    const emptyGroups = Object.entries(spec.experience?.quotes ?? {})
      .filter(([, group]) => !Array.isArray(group.quotes) || group.quotes.length === 0)
      .map(([key]) => key);
    const emptyFeedback = (spec.experience?.interactions ?? [])
      .filter((it) => !Array.isArray(it.feedback) || it.feedback.length === 0)
      .map((it) => it.id);
    const problems = [...emptyGroups.map((k) => `语录组 ${k}`), ...emptyFeedback.map((k) => `互动 ${k}`)];
    return { passed: problems.length === 0, detail: problems.length ? `空语录: ${problems.join(', ')}` : '语录组均非空' };
  },
}));

// ---- 防御性 warning（仅提示，不阻断）----

// 语录组条数过少，避免反馈内容显得单薄
checks.push(makeCheck({
  id: 'quote-group-thin',
  gate: 'quotes',
  severity: 'warning',
  describe: '语录组条数 ≥3，避免反馈单调',
  run: () => {
    const thin = [];
    for (const [key, group] of Object.entries(spec.experience?.quotes ?? {})) {
      if (Array.isArray(group.quotes) && group.quotes.length >= 1 && group.quotes.length < 3) thin.push(`状态语录 ${key}(${group.quotes.length})`);
    }
    for (const it of spec.experience?.interactions ?? []) {
      if (Array.isArray(it.feedback) && it.feedback.length >= 1 && it.feedback.length < 3) thin.push(`互动反馈 ${it.id}(${it.feedback.length})`);
    }
    return { passed: thin.length === 0, detail: thin.length ? `条数偏少: ${thin.join('; ')}` : '语录组均 ≥3 条' };
  },
}));

// 互动时长 vs 一次完整动画周期：超过 3 轮循环通常意味着动画将重复多遍，确认是否有意
checks.push(makeCheck({
  id: 'interaction-duration-excess',
  gate: 'motion',
  severity: 'warning',
  describe: '互动时长不超过 3 个完整动画周期',
  run: () => {
    const excess = [];
    for (const interaction of spec.experience.interactions ?? []) {
      const state = stateById.get(interaction.stateId);
      if (!state) continue;
      const cycleMs = state.frames.length * (state.frameDurationMs ?? 0);
      if (cycleMs > 0 && interaction.durationMs > cycleMs * 3) {
        excess.push(`${interaction.id}: ${interaction.durationMs}ms ≈ ${(interaction.durationMs / cycleMs).toFixed(1)} 个周期`);
      }
    }
    return { passed: excess.length === 0, detail: excess.length ? `动画重复过多轮: ${excess.join('; ')}` : '时长在合理范围' };
  },
}));

// 非互动状态越级全通配（*）：普通状态仅在确实需要绝对打断权时才该越级。
// 系统级状态豁免：notify（提醒到点）与 feed（文件投喂收纳）按设计必须打断一切。
checks.push(makeCheck({
  id: 'caninterrupt-star-broadcast',
  gate: 'interrupt-matrix',
  severity: 'warning',
  describe: '非互动状态持有全通配(*) 的不超过豁免的系统级状态（notify / feed）',
  run: () => {
    const interactionStateIds = new Set((spec.experience.interactions ?? []).map((it) => it.stateId));
    const SYSTEM_WILDCARD = new Set(['notify', 'feed']);
    const wildcard = spec.states
      .filter((state) => !interactionStateIds.has(state.id) && !SYSTEM_WILDCARD.has(state.id) && (state.canInterrupt ?? []).includes('*'))
      .map((state) => state.id);
    return { passed: wildcard.length === 0, detail: wildcard.length ? `普通状态越级全通配: ${wildcard.join(', ')}` : '全通配状态克制' };
  },
}));

// 打断名单包含自身 id：属冗余（自己不能打断自己成环），也应移除
checks.push(makeCheck({
  id: 'caninterrupt-self',
  gate: 'interrupt-matrix',
  severity: 'warning',
  describe: 'canInterrupt 名单不应包含自身 id（自引用成环/冗余）',
  run: () => {
    const selfies = spec.states.filter((state) => (state.canInterrupt ?? []).includes(state.id)).map((state) => state.id);
    return { passed: selfies.length === 0, detail: selfies.length ? `名单含自身: ${selfies.join(', ')}` : '无自引用' };
  },
}));

// 待机表现的进入与续接都由状态机自行调度的内部路径完成（不经 start() 的同状态判定），
// 若声明为 restart，一旦被外部再次下发就会绕过池内互斥重播。故待机表现一律 resume。
checks.push(makeCheck({
  id: 'interrupt-standby-resume',
  gate: 'interrupt-matrix',
  severity: 'warning',
  describe: '待机表现（轮播动作与间歇）不可被重入：interrupt 必须为 resume',
  run: () => {
    const replayable = [...standbyBaseIds].filter((id) => stateById.get(id)?.interrupt !== 'resume');
    return {
      passed: replayable.length === 0,
      detail: replayable.length ? `可被重入的待机状态: ${replayable.join(', ')}` : '待机表现一律 resume',
    };
  },
}));

// 同组语录重复文本：去重后实际条数会缩水，内容可能单调
checks.push(makeCheck({
  id: 'quotes-duplicate-in-group',
  gate: 'quotes',
  severity: 'warning',
  describe: '同一语录组/互动反馈内不存在重复文本',
  run: () => {
    const duplicated = [];
    for (const [key, group] of Object.entries(spec.experience?.quotes ?? {})) {
      const items = Array.isArray(group.quotes) ? group.quotes : [];
      if (new Set(items).size !== items.length) duplicated.push(`状态语录 ${key}`);
    }
    for (const it of spec.experience?.interactions ?? []) {
      const items = Array.isArray(it.feedback) ? it.feedback : [];
      if (new Set(items).size !== items.length) duplicated.push(`互动反馈 ${it.id}`);
    }
    return { passed: duplicated.length === 0, detail: duplicated.length ? `存在重复文本: ${duplicated.join(', ')}` : '语录组内无重复' };
  },
}));

// 单帧时长过短：低于 ~80ms 时动画肉眼易闪烁。
// 分段播放的状态（键盘应和）不参与判定：它由按键事件驱动、单段总时长仅几十毫秒，
// 帧时长由输入节奏决定，不按观赏性动画的观感标准衡量。
checks.push(makeCheck({
  id: 'frame-duration-flicker',
  gate: 'motion',
  severity: 'warning',
  describe: '帧时长(frameDurationMs) ≥ 80ms，避免动画闪烁（分段播放的状态除外）',
  run: () => {
    const flicker = spec.states
      .filter((state) => !state.segments)
      .filter((state) => (state.frameDurationMs ?? 0) > 0 && state.frameDurationMs < 80)
      .map((state) => `${state.id}(${state.frameDurationMs}ms)`);
    return { passed: flicker.length === 0, detail: flicker.length ? `帧时长过短: ${flicker.join(', ')}` : '帧时长均在合理范围' };
  },
}));

// loop 状态单轮周期过短：单轮 <1.5s 的循环看起来急促、像卡顿
checks.push(makeCheck({
  id: 'loop-cycle-brisk',
  gate: 'motion',
  severity: 'warning',
  describe: 'loop 状态单轮动画周期 ≥1500ms，避免循环显得急促',
  run: () => {
    const brisk = spec.states
      .filter((state) => state.loop)
      .map((state) => { const cycle = state.frames.length * (state.frameDurationMs ?? 0); return { id: state.id, cycle }; })
      .filter(({ cycle }) => cycle > 0 && cycle < 1500)
      .map(({ id, cycle }) => `${id}(${cycle}ms)`);
    return { passed: brisk.length === 0, detail: brisk.length ? `循环偏急促: ${brisk.join(', ')}` : 'loop 周期均在合理范围' };
  },
}));

const ok = await runChecks({ name: 'Experience QA', reportFile: 'experience-report.json', checks });
if (!ok) process.exit(1);

console.log(`      (${spec.states.length} states, ${triggerOwners.size} triggers, ${spec.experience.interactions.length} interactions)`);