import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, PROGRESS_CHANNEL, type BridgeCall, type StudioBridge } from '../bridge';
// Every operation is one IPC request on the channel named for it in IPC_CHANNELS.
const calls = Object.fromEntries(
  (Object.keys(IPC_CHANNELS) as BridgeCall[]).map(name => [
    name,
    (...args: unknown[]) => ipcRenderer.invoke(IPC_CHANNELS[name], ...args),
  ]),
) as Pick<StudioBridge, BridgeCall>;
const bridge: StudioBridge = {
  ...calls,
  platform: process.platform,
  onProgress: callback => {
    const fn = (_: unknown, value: string) => callback(value);
    ipcRenderer.on(PROGRESS_CHANNEL, fn);
    return () => ipcRenderer.removeListener(PROGRESS_CHANNEL, fn);
  },
};
contextBridge.exposeInMainWorld('studio', bridge);
