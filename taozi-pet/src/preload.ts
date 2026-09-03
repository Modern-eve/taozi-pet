import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DashboardView, InteractionResult, InteractionSpec, PetAPI, PetStats, Reminder, RuntimeFailureReport, RuntimeReadyReport, Settings, StateActivity, TypingStatus } from './shared/contracts';

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api: PetAPI = {
  settings: {
    get: () => ipcRenderer.invoke('settings:get') as Promise<Settings>,
    update: (patch) => ipcRenderer.invoke('settings:update', patch) as Promise<Settings>,
  },
  reminders: {
    list: () => ipcRenderer.invoke('reminders:list') as Promise<Reminder[]>,
    save: (input) => ipcRenderer.invoke('reminders:save', input) as Promise<Reminder>,
    remove: (id) => ipcRenderer.invoke('reminders:remove', id) as Promise<boolean>,
    ack: () => ipcRenderer.invoke('reminders:ack') as Promise<boolean>,
  },
  quotes: {
    get: () => ipcRenderer.invoke('quotes:get') as Promise<Record<string, string[]>>,
    save: (quotes) => ipcRenderer.invoke('quotes:save', quotes) as Promise<void>,
  },
  data: {
    reset: () => ipcRenderer.invoke('data:reset') as Promise<void>,
  },
  dev: {
    triggerSleep: () => ipcRenderer.invoke('dev:trigger-sleep') as Promise<void>,
    triggerWalk: () => ipcRenderer.invoke('dev:trigger-walk') as Promise<void>,
    triggerWalkOnce: () => ipcRenderer.invoke('dev:trigger-walk-once') as Promise<void>,
    setMood: (value) => ipcRenderer.invoke('dev:set-mood', value) as Promise<PetStats>,
  },
  interactions: {
    list: () => ipcRenderer.invoke('interactions:list') as Promise<InteractionSpec[]>,
    trigger: (id) => ipcRenderer.invoke('interactions:trigger', id) as Promise<InteractionResult>,
    stats: () => ipcRenderer.invoke('interactions:stats') as Promise<PetStats>,
  },
  files: {
    getPathForFile: (file) => webUtils.getPathForFile(file),
    put: (paths) => ipcRenderer.invoke('files:put', paths),
    openPocket: () => ipcRenderer.invoke('files:open-pocket') as Promise<void>,
  },
  window: {
    beginDrag: () => ipcRenderer.invoke('window:drag-begin') as Promise<void>,
    updateDrag: () => ipcRenderer.invoke('window:drag-update') as Promise<void>,
    endDrag: () => ipcRenderer.invoke('window:drag-end') as Promise<void>,
    showContextMenu: () => ipcRenderer.invoke('window:show-context-menu') as Promise<void>,
    showDashboard: (view?: DashboardView) => ipcRenderer.invoke('window:show-dashboard', view) as Promise<void>,
    hideDashboard: () => ipcRenderer.invoke('window:hide-dashboard') as Promise<void>,
    hidePet: () => ipcRenderer.invoke('window:hide-pet') as Promise<void>,
  },
  runtime: {
    ready: (report: RuntimeReadyReport) => ipcRenderer.invoke('runtime:ready', report) as Promise<void>,
    fail: (report: RuntimeFailureReport) => ipcRenderer.invoke('runtime:fail', report) as Promise<void>,
  },
  events: {
    onStateActivity: (listener) => subscribe<StateActivity>('state:activity', listener),
    onRemindersUpdated: (listener) => subscribe<void>('reminders:updated', listener),
    onQuotesChanged: (listener) => subscribe<void>('quotes:changed', listener),
    onDashboardView: (listener) => subscribe<DashboardView>('dashboard:view', listener),
    onStats: (listener) => subscribe<PetStats>('pet:stats', listener),
    onTypingStatus: (listener) => subscribe<TypingStatus>('typing:status', listener),
    onPetSizeApplied: (listener) => subscribe<void>('pet:size-applied', listener),
  },
};

contextBridge.exposeInMainWorld('petAPI', api);
if (process.env.PET_E2E === '1') {
  contextBridge.exposeInMainWorld('__petE2E', {
    snapshot: () => ipcRenderer.invoke('runtime:e2e-snapshot'),
    quit: () => ipcRenderer.invoke('runtime:e2e-quit'),
  });
}

function currentRole(): 'pet' | 'dashboard' | undefined {
  const pathname = window.location.pathname;
  if (pathname.includes('/pet_window/')) return 'pet';
  if (pathname.includes('/dashboard_window/')) return 'dashboard';
  return undefined;
}

function reportRendererFailure(message: string): void {
  const role = currentRole();
  if (!role) return;
  void ipcRenderer.invoke('runtime:renderer-failed', { role, message });
}

window.addEventListener('error', (event) => {
  reportRendererFailure(event.error instanceof Error ? event.error.stack || event.error.message : event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  reportRendererFailure(event.reason instanceof Error ? event.reason.stack || event.reason.message : String(event.reason));
});

window.addEventListener('DOMContentLoaded', () => {
  const role = currentRole();
  if (!role) {
    reportRendererFailure(`Cannot resolve renderer role from ${window.location.pathname}`);
    return;
  }
  window.setTimeout(() => {
    void ipcRenderer.invoke('runtime:renderer-ready', { role, bootstrapComplete: true });
  }, 0);
});
