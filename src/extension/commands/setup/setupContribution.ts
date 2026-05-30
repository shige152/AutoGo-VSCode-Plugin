import * as vscode from 'vscode';
import { ArtifactStore } from '../../../app/services/artifactStore';
import { AdbService } from '../../../services/adbService';
import { ConfigService, CONFIG_SECTION } from '../../../services/configService';
import { OutputChannel } from '../../../services/outputChannel';
import { UpdateAutoGoService, VersionInfo } from './updateAutoGoService';
import { executeCommand } from '../../../utils/processUtils';
import {
  USER_MESSAGES,
  formatDeviceConnectionCheckFailed,
  formatDeviceNotConnected,
} from '../../../utils/userMessages';
import { ensureLogViewVisible } from '../../views/logViewVisibility';
import { SettingsPanel } from '../../views/SettingsPanel';
import { checkDeviceConnection } from '../shared/deviceConnection';
import { registerInitCommand } from './initProject';
import { registerNodeAidCommand } from './openNodeAid';
import { registerSetAdbPathCommand } from './setAdbPath';
import { registerShowAgHelpCommand } from './showAgHelp';
import { registerUpdateAutoGoCommand } from './updateAutoGo';
import { registerSettingsCommand } from '../settings/openSettings';
import { iosConnectionManager } from '../../../infra/ios/connectionManager';
import { DEFAULT_IOS_HTTP_PORT } from '../../../infra/ios/protocol/messageTypes';

export interface SetupCommandDeps {
  context: vscode.ExtensionContext;
  outputChannel: OutputChannel;
  configService: ConfigService;
  adbService: AdbService;
  artifactStore: ArtifactStore;
  getAgPath: () => string | null;
  refreshAgPath: () => Promise<string | null>;
  getLogViewPreference: () => 'Panel' | 'View' | 'None';
}

async function showVersionPicker(
  versions: VersionInfo[],
  localVersion: string | null,
): Promise<string | undefined> {
  type VersionPickItem = vscode.QuickPickItem & { rawVersion: string };
  const formatVersionChanges = (changes: string[]): string => {
    if (changes.length === 0) {
      return '暂无更新说明';
    }

    const normalizedChanges = changes.map((change) => `• ${change.replace(/^\s*[-*]\s*/, '').trim()}`);
    return normalizedChanges[0];
  };

  const items: VersionPickItem[] = versions.map((version) => {
    const isCurrent = localVersion && version.version === localVersion;
    const label = `$(tag) ${version.version}`;

    let description = '';
    if (version.date) {
      description += `$(calendar) ${version.date}`;
    }
    if (version.cached) {
      description += '  $(database) 已下载';
    }
    if (isCurrent) {
      description += '  $(check) 当前版本';
    }

    return {
      label,
      description,
      detail: formatVersionChanges(version.changes),
      rawVersion: version.version,
    };
  });

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: `选择要安装的版本 (当前: ${localVersion || '未知'})`,
    title: '更新 AutoGo SDK',
  });

  return selected?.rawVersion;
}

function isLikelyIosDeviceHost(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  const ipPattern = /^(\d{1,3}\.){3}\d{1,3}$/;
  return ipPattern.test(trimmed);
}

export function registerSetupCommands(deps: SetupCommandDeps): vscode.Disposable[] {
  const {
    context,
    outputChannel,
    configService,
    adbService,
    artifactStore,
    getAgPath,
    refreshAgPath,
    getLogViewPreference,
  } = deps;

  const updateAutoGo = new UpdateAutoGoService(outputChannel, configService);
  const iosDeviceStateKey = 'autogo.selectedIosDevice';
  const logActionState = (
    action: string,
    state: 'start' | 'success' | 'failure'
  ): void => {
    if (state === 'start') {
      outputChannel.success(`开始${action}`);
      return;
    }

    if (state === 'success') {
      outputChannel.success(`${action}结束`);
      return;
    }

    outputChannel.error(`${action}失败`);
  };

  const disposables: vscode.Disposable[] = [];

  disposables.push(
    registerInitCommand(async () => {
      ensureLogViewVisible(context, getLogViewPreference());
      const agPath = getAgPath();
      if (!agPath) {
        return;
      }
      const debugMode = configService.debugMode;

      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        outputChannel.error(USER_MESSAGES.workspaceNotFound);
        return;
      }
      const cwd = workspaceFolders[0].uri.fsPath;

      const platform = await vscode.window.showQuickPick(
        [
          { label: 'Android', description: 'Android 平台', value: 'android' },
          { label: 'iOS', description: 'iOS 平台', value: 'ios' },
        ],
        {
          placeHolder: '选择目标平台',
          title: '目标平台选择',
        }
      );

      if (!platform) {
        return;
      }

      await vscode.workspace.getConfiguration(CONFIG_SECTION).update('targetPlatform', platform.value, vscode.ConfigurationTarget.Workspace);
      logActionState('初始化', 'start');

      try {
        const result = await executeCommand(
          agPath,
          ['init', '-t', platform.value],
          outputChannel,
          {
            cwd: cwd,
            debugMode: debugMode,
            commandDisplayName: '初始化',
            configService: configService,
          }
        );

        if (!result.success) {
          logActionState('初始化', 'failure');
          return;
        }

        logActionState('初始化', 'success');
      } catch (error) {
        logActionState('初始化', 'failure');
        if (debugMode) {
          const errorMsg = `执行初始化命令时发生未预料的异常: ${error instanceof Error ? error.message : String(error)}`;
          outputChannel.error(errorMsg);
        }
      }
    }),
    registerShowAgHelpCommand(async () => {
      ensureLogViewVisible(context, getLogViewPreference());
      const agPath = getAgPath();
      if (!agPath) {
        return;
      }
      const debugMode = configService.debugMode;

      const command = `"${agPath}" help`;
      if (debugMode) {
        outputChannel.success(`执行命令: ${command}`);
      }

      try {
        await executeCommand(agPath, ['help'], outputChannel, {
          debugMode: debugMode,
          commandDisplayName: '帮助信息',
          configService: configService,
        });
      } catch (error) {
        outputChannel.error(USER_MESSAGES.helpFetchFailed);
        if (debugMode) {
          const errorMsg = `执行帮助命令时发生异常: ${error instanceof Error ? error.message : String(error)}`;
          outputChannel.error(errorMsg);
        }
      }
    }),
    registerSettingsCommand(() => {
      SettingsPanel.render(context, outputChannel, configService, artifactStore, artifactStore.getManagedAgPath());
    }),
    registerUpdateAutoGoCommand(async () => {
      ensureLogViewVisible(context, getLogViewPreference());

      try {
        outputChannel.success('正在检查更新...');

        const agExecutablePath = artifactStore.getManagedAgPath();
        const localVersion = await updateAutoGo.getLocalVersion(agExecutablePath);
        if (localVersion) {
          outputChannel.log(`本地版本: ${localVersion}`);
        } else {
          outputChannel.log('本地版本: 未安装或未知');
        }

        const versions = await updateAutoGo.fetchVersions();
        if (versions.length === 0) {
          outputChannel.error('解析版本信息失败');
          vscode.window.showErrorMessage('解析版本信息失败');
          return;
        }

        outputChannel.log(`最新版本: ${versions[0].version}`);
        outputChannel.log('--- 近期更新日志 ---');
        versions.slice(0, 5).forEach((version) => {
          outputChannel.log(`[${version.version}] ${version.date}`);
          version.changes.forEach((change) => outputChannel.log(`  ${change}`));
          outputChannel.log('');
        });

        const selectedVersion = await showVersionPicker(versions, localVersion);
        if (!selectedVersion) {
          return;
        }

        const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        await updateAutoGo.downloadAndInstall(selectedVersion, agExecutablePath, workspaceDir);
        await refreshAgPath();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (configService.debugMode) {
          outputChannel.error(`处理更新请求时出错: ${errorMessage}`);
        } else {
          outputChannel.error('更新请求处理失败');
        }
        vscode.window.showErrorMessage(`更新失败: ${errorMessage}`);
      }
    }),
    registerNodeAidCommand(async () => {
      ensureLogViewVisible(context, getLogViewPreference());
      const debugMode = configService.debugMode;

      if (configService.targetPlatform === 'ios') {
        const devices = iosConnectionManager.getAllDevices();
        let selectedHost = context.globalState.get<string>(iosDeviceStateKey, '').trim() || configService.selectedDevice.trim();
        if (!isLikelyIosDeviceHost(selectedHost)) {
          selectedHost = '';
        }
        if (selectedHost && !devices.some((device) => device.id === selectedHost)) {
          if (debugMode) {
            outputChannel.log(`已保存的 iOS 设备不可用，准备重新选择: ${selectedHost}`);
          }
          selectedHost = '';
        }

        if (!selectedHost) {
          if (devices.length > 0) {
            const selected = await vscode.window.showQuickPick(
              devices.map((device) => ({
                label: device.id,
                description: `连接于 ${device.connectedAt.toLocaleString()}`,
                host: device.id,
              })),
              { placeHolder: '选择要打开节点助手的 iOS 设备' }
            );

            if (!selected) {
              return;
            }

            selectedHost = selected.host;
          }
        }

        if (!selectedHost) {
          const message = USER_MESSAGES.noIosDeviceConnected;
          outputChannel.error(message);
          return;
        }

        if (selectedHost !== context.globalState.get<string>(iosDeviceStateKey, '').trim()) {
          await context.globalState.update(iosDeviceStateKey, selectedHost);
          if (debugMode) {
            outputChannel.log(`状态已更新: ${iosDeviceStateKey} = ${selectedHost}`);
          }
        }

        const nodeaidUrl = `http://${selectedHost}:${DEFAULT_IOS_HTTP_PORT}/node`;
        outputChannel.success(`打开节点助手: ${nodeaidUrl}`);
        await vscode.env.openExternal(vscode.Uri.parse(nodeaidUrl));
        return;
      }

      const agPath = getAgPath();
      if (!agPath) {
        return;
      }

      const selectedDevice = configService.selectedDevice;

      if (!selectedDevice) {
        const message = USER_MESSAGES.deviceNotSelected;
        outputChannel.error(message);
        return;
      }

      const connectionStatus = await checkDeviceConnection(adbService, outputChannel, selectedDevice, configService);
      if (connectionStatus !== 'connected') {
        const message =
          connectionStatus === 'not_connected'
            ? formatDeviceNotConnected(selectedDevice)
            : formatDeviceConnectionCheckFailed(selectedDevice);
        outputChannel.error(message);
        return;
      }

      const nodeaidUrl = `http://127.0.0.1:8801/index.html?device=${selectedDevice}`;

      try {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        let cwd: string | undefined;
        if (workspaceFolders && workspaceFolders.length > 0) {
          cwd = workspaceFolders[0].uri.fsPath;
        } else if (debugMode) {
          outputChannel.warn('未找到工作区，可能无法正确启动节点助手。');
        }

        const result = await executeCommand(
          agPath,
          ['nodeserve'],
          outputChannel,
          {
            cwd: cwd,
            debugMode: debugMode,
            commandDisplayName: '启动节点助手服务',
            configService: configService,
          }
        );

        if (!result.success) {
          outputChannel.error(USER_MESSAGES.nodeAssistantOpenFailed);
          return;
        }

        outputChannel.success(`打开节点助手: ${nodeaidUrl}`);
        vscode.env.openExternal(vscode.Uri.parse(nodeaidUrl));
      } catch (error) {
        const errorMsg = `执行节点助手命令时发生未预料的异常: ${error instanceof Error ? error.message : String(error)}`;
        outputChannel.error(errorMsg);
      }
    }),
    registerSetAdbPathCommand(async () => {
      const adbPath = await vscode.window.showInputBox({
        prompt: '请输入 ADB 可执行文件的完整路径',
        placeHolder: '例如: C:\\platform-tools\\adb.exe',
      });

      if (!adbPath) {
        return;
      }

      try {
        await vscode.workspace.getConfiguration(CONFIG_SECTION).update('adbPath', adbPath, vscode.ConfigurationTarget.Global);
        outputChannel.success(`ADB 路径已设置: ${adbPath}`);
        SettingsPanel.postMessageToWebview({ command: 'adbPathUpdated', path: adbPath });
      } catch (error: any) {
        outputChannel.error(`设置 ADB 路径失败: ${error.message}`);
      }
    }),
  );

  return disposables;
}
