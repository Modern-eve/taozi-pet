import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { makeCheck, runChecks, PROJECT_ROOT } from './qa-common.mjs';

const specText = await readFile(path.join(PROJECT_ROOT, 'pet-spec.json'), 'utf8');
const packageText = await readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8');
const spec = JSON.parse(specText);
const packageJson = JSON.parse(packageText);

const knownTriggers = new Set([
  'app:start', 'ambient:idle', 'ambient:blink', 'ambient:belly-ok', 'ambient:kick', 'ambient:random', 'pointer:tap', 'window:drag', 'window:edge-snap',
  'reminder:due', 'typing:activity', 'file:drop', 'file:drop-success', 'file:drop-fail',
]);

// 顶层构建一次共享映射，供 states/interactions 两个 check 闭包复用
const states = new Map((spec.states ?? []).map((state) => [state.id, state]));
const frameOwners = new Map();
const sharedFrames = new Set();
for (const state of spec.states ?? []) for (const frame of state.frames ?? []) {
  const previous = frameOwners.get(frame);
  if (previous !== undefined && previous !== state.id) sharedFrames.add(frame);
  else frameOwners.set(frame, state.id);
}
const triggers = new Map();
for (const state of spec.states ?? []) for (const trigger of state.triggers ?? []) {
  if (!triggers.has(trigger)) triggers.set(trigger, state.id);
}
const interactions = new Map((spec.experience?.interactions ?? []).map((interaction) => [interaction.id, interaction]));

const conditional = {
  reminders: ['reminder:due'],
  edgeSnap: ['window:edge-snap'],
  typingReaction: ['typing:activity'],
  filePocket: ['file:drop', 'file:drop-success', 'file:drop-fail'],
};

const checks = [];

// ---- 应用元信息契约 ----
checks.push(makeCheck({
  id: 'app-meta',
  gate: 'spec-contract',
  describe: 'schema/编码/appId 契约一致',
  run: () => {
    const problems = [];
    if (spec.schemaVersion !== 6) problems.push('schemaVersion 必须等于 6');
    const mojibake = /\ufffd|锛|鈥|灏忛噾|妗屽疇|鍠傚皬|鎽告懜/u;
    if (mojibake.test(specText) || mojibake.test(packageText)) problems.push('疑似 UTF-8/GBK 乱码；请恢复 UTF-8 源文件');
    if (!/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z0-9-]+)+$/.test(spec.app?.appId ?? '')) problems.push('app.appId 必须是反向域名标识');
    return { passed: problems.length === 0, detail: problems.length ? problems.join('; ') : '元信息一致' };
  },
}));

// ---- 素材管线 / 尺寸 / build 配置 ----
checks.push(makeCheck({
  id: 'config-pipeline',
  gate: 'spec-contract',
  describe: 'assetPipeline 阈值、petSizing、features/build/storage 配置合法',
  run: () => {
    const problems = [];
    const pipeline = spec.assetPipeline ?? {};
    if (pipeline.backgroundMode !== 'adaptive-flood') problems.push('assetPipeline.backgroundMode 必须为 adaptive-flood');
    if (!['transparent-grid', 'solid-chroma'].includes(pipeline.generationBackground)) problems.push('assetPipeline.generationBackground 必须为 transparent-grid 或 solid-chroma');
    if (!Number.isInteger(pipeline.backgroundTolerance) || pipeline.backgroundTolerance < 12 || pipeline.backgroundTolerance > 48) problems.push('assetPipeline.backgroundTolerance 必须为 12-48');
    if (!Number.isInteger(pipeline.edgeFeather) || pipeline.edgeFeather < 4 || pipeline.edgeFeather > 24) problems.push('assetPipeline.edgeFeather 必须为 4-24');
    if (!Number.isInteger(pipeline.safeMargin) || pipeline.safeMargin < 16 || pipeline.safeMargin > 64) problems.push('assetPipeline.safeMargin 必须为 16-64');
    if (typeof pipeline.targetOccupancy !== 'number' || pipeline.targetOccupancy < 0.65 || pipeline.targetOccupancy > 0.82) problems.push('assetPipeline.targetOccupancy 必须为 0.65-0.82');
    if (typeof pipeline.occupancyTolerance !== 'number' || pipeline.occupancyTolerance <= 0 || pipeline.occupancyTolerance > 0.06) problems.push('assetPipeline.occupancyTolerance 必须为 0-0.06 的数值');
    if (pipeline.targetOccupancy + pipeline.occupancyTolerance > 0.85) problems.push('assetPipeline.targetOccupancy+occupancyTolerance 不得大于 0.85（否则主体会顶到画布边）');
    if (!Number.isInteger(pipeline.sourceCanvas) || pipeline.sourceCanvas < 256 || pipeline.sourceCanvas > 4096) problems.push('assetPipeline.sourceCanvas 必须为 256-4096');
    if (!Number.isInteger(pipeline.sourceMargin) || pipeline.sourceMargin < 0 || pipeline.sourceMargin > 256) problems.push('assetPipeline.sourceMargin 必须为 0-256');
    if (typeof pipeline.sourceOccupancy !== 'number' || pipeline.sourceOccupancy < 0.3 || pipeline.sourceOccupancy > 0.8) problems.push('assetPipeline.sourceOccupancy 必须为 0.3-0.8');
    if (!Number.isInteger(pipeline.sourcePad) || pipeline.sourcePad < 0 || pipeline.sourcePad > 32) problems.push('assetPipeline.sourcePad 必须为 0-32');
    // 归一化/漂移阈值：全部状态共用一套（不做 idle 等特殊状态分支），故只校验数值本身。
    if (typeof pipeline.sourceScaleAxisCap !== 'number' || pipeline.sourceScaleAxisCap <= 0 || pipeline.sourceScaleAxisCap > 0.06) problems.push('assetPipeline.sourceScaleAxisCap 必须为 0-0.06 的数值');
    if (typeof pipeline.processMaxCorrection !== 'number' || pipeline.processMaxCorrection < 1 || pipeline.processMaxCorrection > 1.3) problems.push('assetPipeline.processMaxCorrection 必须为 1-1.3 的数值');
    if (typeof pipeline.qaMaxScaleRatio !== 'number' || pipeline.qaMaxScaleRatio < 1 || pipeline.qaMaxScaleRatio > 1.3) problems.push('assetPipeline.qaMaxScaleRatio 必须为 1-1.3 的数值');
    if (typeof pipeline.qaMaxCenterDrift !== 'number' || pipeline.qaMaxCenterDrift <= 0 || pipeline.qaMaxCenterDrift > 0.1) problems.push('assetPipeline.qaMaxCenterDrift 必须为 0-0.1 的数值');
    if (typeof pipeline.qaMaxBottomDrift !== 'number' || pipeline.qaMaxBottomDrift <= 0 || pipeline.qaMaxBottomDrift > 0.1) problems.push('assetPipeline.qaMaxBottomDrift 必须为 0-0.1 的数值');
    if (pipeline.qaMaxScaleRatio <= 1 + pipeline.sourceScaleAxisCap) problems.push('assetPipeline.qaMaxScaleRatio 必须大于 1+sourceScaleAxisCap（否则 assemble 的合法输出会被 qa 判失败）');
    const sizing = spec.experience?.petSizing ?? {};
    if (!Number.isInteger(sizing.baseWindowPx) || sizing.baseWindowPx < 180 || sizing.baseWindowPx > 260) problems.push('experience.petSizing.baseWindowPx 必须为 180-260');
    if (![0.65, 0.8, 1, 1.2].includes(sizing.defaultScale)) problems.push('experience.petSizing.defaultScale 必须是 0.65/0.8/1/1.2 之一');
    if (spec.features?.transparentWindow !== true) problems.push('features.transparentWindow 必须为 true');
    if (spec.build?.unsigned !== true) problems.push('build.unsigned 必须显式为 true');
    if (spec.build?.windows?.arch !== 'x64') problems.push('Windows 架构必须为 x64');
    if (!Number.isInteger(spec.build?.timeoutMinutes) || spec.build.timeoutMinutes < 5 || spec.build.timeoutMinutes > 60) problems.push('构建超时必须为 5-60 分钟');
    if (spec.storage?.userData !== 'app-user-data' || spec.storage?.filePocket !== 'documents-app-name') problems.push('存储路径必须使用跨平台策略');
    const maintenance = spec.maintenance ?? {};
    if (typeof maintenance.cacheSweepOnStartup !== 'boolean') problems.push('maintenance.cacheSweepOnStartup 必须为布尔值');
    if (!Number.isInteger(maintenance.diskCacheLimitMb) || maintenance.diskCacheLimitMb < 0 || maintenance.diskCacheLimitMb > 512) problems.push('maintenance.diskCacheLimitMb 必须为 0-512 的整数');
    if (!Number.isInteger(maintenance.keepCorruptFiles) || maintenance.keepCorruptFiles < 0 || maintenance.keepCorruptFiles > 20) problems.push('maintenance.keepCorruptFiles 必须为 0-20 的整数');
    if (!Number.isInteger(maintenance.logMaxKb) || maintenance.logMaxKb < 64 || maintenance.logMaxKb > 10240) problems.push('maintenance.logMaxKb 必须为 64-10240 的整数');
    return { passed: problems.length === 0, detail: problems.length ? problems.join('; ') : '配置合法' };
  },
}));

// ---- 状态机结构 ----
checks.push(makeCheck({
  id: 'states',
  gate: 'spec-contract',
  describe: '状态 id/帧归属/触发唯一性/base trigger/条件联动合法',
  run: () => {
    const problems = [];
    for (const state of spec.states ?? []) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(state.id ?? '')) problems.push(`非法状态 id: ${state.id}`);
      if (!Array.isArray(state.frames) || state.frames.length < 1) problems.push(`状态无帧: ${state.id}`);
      for (const frame of state.frames ?? []) {
        if (typeof frame !== 'string' || /^[A-Za-z]:|^[/\\]|(?:^|[/\\])\.\.(?:[/\\]|$)/.test(frame)) problems.push(`不安全的帧路径: ${frame}`);
      }
      if (!Array.isArray(state.triggers) || !state.triggers.length) problems.push(`状态无运行时触发: ${state.id}`);
    }
    for (const frame of sharedFrames) problems.push(`帧 ${frame} 归属多个状态（跨状态共享帧冲突）`);
    const triggerToState = new Map();
    for (const state of spec.states ?? []) for (const trigger of state.triggers ?? []) {
      if (!knownTriggers.has(trigger) && !(trigger.startsWith('interaction:') && interactions.has(trigger.slice(12))) && !trigger.startsWith('state:')) problems.push(`未知触发 ${trigger}（位于 ${state.id}）`);
      if (triggerToState.has(trigger)) problems.push(`触发 ${trigger} 同时归属 ${triggerToState.get(trigger)} 与 ${state.id}`);
      else triggerToState.set(trigger, state.id);
    }
    if (states.has('idle')) problems.push('idle 是待机调度信号，不能用作状态 id');
    // 待机轮播池：待机由池内动作按权重随机单轮播放，播完续接下一个
    const rotation = spec.idleRotation?.states ?? [];
    if (!rotation.length) problems.push('待机轮播池 idleRotation.states 不能为空');
    for (const entry of rotation) {
      const state = states.get(entry.id);
      if (!state) { problems.push(`待机动作 ${entry.id} 不存在于 states`); continue; }
      if (!(typeof entry.weight === 'number' && entry.weight > 0)) problems.push(`待机动作 ${entry.id} 的权重必须为正数`);
      if (state.loop) problems.push(`待机动作 ${entry.id} 必须单轮播放（loop 必须为 false）`);
    }
    // 待机间歇：轮播动作播完后停顿，期间展示 gap.stateId 指向状态的单帧静态帧；
    // 长度按随机行走挡位取（0 木头人 … 4 多动症），以呼吸次数计，挡位越高呼吸次数越少。
    const gap = spec.idleRotation?.gap;
    if (!gap || typeof gap.stateId !== 'string') problems.push('待机间歇 idleRotation.gap.stateId 缺失');
    else {
      const gapState = states.get(gap.stateId);
      if (!gapState) problems.push(`待机间歇状态 ${gap.stateId} 不存在于 states`);
      else {
        if (new Set(gapState.frames ?? []).size !== 1) problems.push(`待机间歇状态 ${gap.stateId} 必须是单帧静态帧`);
        if (rotation.some((entry) => entry.id === gap.stateId)) problems.push(`待机间歇状态 ${gap.stateId} 不得同时参与轮播`);
      }
      const levels = gap.levels;
      if (!Array.isArray(levels) || levels.length !== 5) {
        problems.push('待机间歇 idleRotation.gap.levels 必须按 5 个随机行走挡位（0–4）各给一个区间');
      } else {
        levels.forEach((level, index) => {
          if (!(Number.isInteger(level?.minBreaths) && level.minBreaths > 0)) problems.push(`待机间歇第 ${index} 档 minBreaths 必须为正整数`);
          if (!(Number.isInteger(level?.maxBreaths) && level.maxBreaths >= (level?.minBreaths ?? 0))) problems.push(`待机间歇第 ${index} 档 maxBreaths 必须为不小于 minBreaths 的整数`);
        });
      }
    }
    for (const trigger of ['app:start', 'ambient:idle', 'ambient:blink', 'pointer:tap']) if (!triggers.has(trigger)) problems.push(`缺少基础触发: ${trigger}`);
    for (const [feature, required] of Object.entries(conditional)) {
      for (const trigger of required) {
        if (spec.features?.[feature] && !triggers.has(trigger)) problems.push(`${feature} 已启用但 ${trigger} 未实现`);
        if (!spec.features?.[feature] && triggers.has(trigger)) problems.push(`${trigger} 存在但 ${feature} 已禁用`);
      }
    }
    return { passed: problems.length === 0, detail: problems.length ? problems.join('; ') : `${states.size} states 结构合法` };
  },
}));

// ---- 帧数产能约束 / 互动动作连通 ----
checks.push(makeCheck({
  id: 'interactions-and-framing',
  gate: 'spec-contract',
  describe: '互动动作 emoji/状态/触发/时长与帧数产能区间合法',
  run: () => {
    const problems = [];
    if (spec.features?.interactions && interactions.size < 2) problems.push('启用的互动至少需要两个角色专属动作');
    for (const [id, interaction] of interactions) {
      if (typeof interaction.emoji !== 'string' || interaction.emoji.length < 1 || interaction.emoji.length > 8) problems.push(`互动 ${id} 需要简短 emoji`);
      const state = states.get(interaction.stateId);
      if (!state) { problems.push(`互动 ${id} 引用不存在的状态 ${interaction.stateId}`); continue; }
      if (!triggers.has(`interaction:${id}`)) problems.push(`互动 ${id} 无运行时触发`);
      if (state.frames.length < 5 || state.frames.length > 24) problems.push(`互动状态 ${state.id} 帧数必须为 5-24`);
      if (interaction.durationMs < state.frames.length * state.frameDurationMs) problems.push(`互动 ${id} 时长须覆盖一个完整动画周期`);
    }
    const blink = states.get(triggers.get('ambient:blink'));
    if (blink && (blink.frames.length < 5 || blink.frames.length > 24)) problems.push('blink 帧数必须为 5-24');
    // 待机动作帧数：决定单个动作轮播一轮的时长（250ms/帧），过短会闪、过长会占住待机
    for (const entry of spec.idleRotation?.states ?? []) {
      const state = states.get(entry.id);
      if (state && (state.frames.length < 4 || state.frames.length > 24)) problems.push(`待机动作 ${state.id} 帧数必须为 4-24`);
    }
    for (const trigger of ['pointer:tap', 'reminder:due', 'window:edge-snap', 'ambient:random']) {
      const state = states.get(triggers.get(trigger));
      if (state && (state.frames.length < 5 || state.frames.length > 24)) problems.push(`「${trigger}」状态 ${state.id} 帧数必须为 5-24`);
    }
    return { passed: problems.length === 0, detail: problems.length ? problems.join('; ') : `${interactions.size} interactions 合法` };
  },
}));

const ok = await runChecks({ name: 'Spec Validation', reportFile: 'spec-validation-report.json', checks });
if (!ok) process.exit(1);
console.log(`      (${states.size} states, ${triggers.size} triggers, ${interactions.size} interactions)`);