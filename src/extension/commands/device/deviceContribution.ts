import * as child_process from 'child_process';
import * as vscode from 'vscode';
import { AdbService } from '../../../services/adbService';
import { IosDebugService } from '../../../services/iosDebugService';
import { ConfigService, CONFIG_SECTION } from '../../../services/configService';
import { OutputChannel } from '../../../services/outputChannel';
import { ensureLogViewVisible } from '../../views/logViewVisibility';
import { registerConnectCommand } from './connectDevice';
import { resolveAdbPathForCommand } from '../../adbPathResolver';
import { DEFAULT_IOS_DEBUG_PORT } from '../../../infra/ios/protocol/messageTypes';
import { executeCommand } from '../../../utils/processUtils';
import { normalizeAutoGoRemotePairingAddress } from './autoGoRemotePairing';
import {
  parseAdbMdnsPairingServices,
} from './adbWirelessPairing';

const ADB_PAIRING_SERVICE_WAIT_TIMEOUT_MS = 60_000;

export interface DeviceCommandDeps {
  context: vscode.ExtensionContext;
  outputChannel: OutputChannel;
  configService: ConfigService;
  adbService: AdbService;
  iosDebugService: IosDebugService;
  resolveAgPath: () => Promise<string | null>;
  getLogViewPreference: () => 'Panel' | 'View' | 'None';
}

export function registerDeviceCommands(deps: DeviceCommandDeps): vscode.Disposable[] {
  const { context, outputChannel, configService, adbService, iosDebugService, resolveAgPath, getLogViewPreference } = deps;
  const iosDeviceStateKey = 'autogo.selectedIosDevice';
  const disposables: vscode.Disposable[] = [];
  const logActionState = (state: 'start' | 'success' | 'failure'): void => {
    if (state === 'start') {
      outputChannel.success('开始连接');
      return;
    }

    if (state === 'success') {
      outputChannel.success('连接结束');
      return;
    }

    outputChannel.error('连接失败');
  };

  disposables.push(
    registerConnectCommand(async () => {
      ensureLogViewVisible(context, getLogViewPreference());

      // iOS 平台使用 TCP 协议连接
      if (configService.targetPlatform === 'ios') {
        await connectIosDevice();
        return;
      }

      // Android 平台使用 ADB 设备列表；AutoGo 远程调试配对码可独立使用 AG connect。
      const adbPath = await resolveAdbPathForCommand(configService, outputChannel);
      const quickPickItems: string[] = ['远程调试'];
      if (adbPath) {
        const devices = await adbService.getDevices(adbPath);
        if (devices.length > 0) {
          devices.forEach((device: string) => {
            quickPickItems.push(device);
          });
        }
      }

      const selectedOption = await vscode.window.showQuickPick(quickPickItems, {
        placeHolder: '选择连接方式或设备',
      });

      if (!selectedOption) {
        return;
      }

      if (selectedOption === '远程调试') {
         await connectWireless(
           outputChannel,
           configService,
           resolveAgPath,
           () => resolveAdbPathForCommand(configService, outputChannel),
           adbPath
         );
      } else {
        const selectedDevice = selectedOption;

        try {
          await vscode.workspace
            .getConfiguration(CONFIG_SECTION)
            .update('selectedDevice', selectedDevice, vscode.ConfigurationTarget.Global);
          outputChannel.success(`已选择设备: ${selectedDevice}`);
          if (configService.debugMode) {
            outputChannel.log(`配置已更新: selectedDevice = ${selectedDevice}`);
          }
        } catch (updateError) {
          outputChannel.error(
            `更新设备配置失败: ${updateError instanceof Error ? updateError.message : String(updateError)}`
          );
        }
      }

      async function connectIosDevice(): Promise<void> {
        // 1. 获取设备 IP 地址
        const host = await vscode.window.showInputBox({
          prompt: '请输入 iOS 设备的 IP 地址',
          placeHolder: '例如: 192.168.1.100',
          validateInput: (value) => {
            if (!value || value.trim().length === 0) {
              return 'IP 地址不能为空';
            }
            // 简单的 IP 格式验证
            const ipPattern = /^(\d{1,3}\.){3}\d{1,3}$/;
            if (!ipPattern.test(value.trim())) {
              return '请输入有效的 IP 地址格式';
            }
            return null;
          },
        });

        if (!host) {
          return;
        }

        const normalizedHost = host.trim();

        // 2. 执行连接（端口固定 8820）
        logActionState('start');
        const success = await iosDebugService.connectDevice(normalizedHost, DEFAULT_IOS_DEBUG_PORT);

        if (success) {
          logActionState('success');
          try {
            await context.globalState.update(iosDeviceStateKey, normalizedHost);
            outputChannel.success(`已选择 iOS 设备: ${normalizedHost}`);
            if (configService.debugMode) {
              outputChannel.log(`状态已更新: ${iosDeviceStateKey} = ${normalizedHost}`);
            }
          } catch (updateError) {
            outputChannel.error(
              `更新设备配置失败: ${updateError instanceof Error ? updateError.message : String(updateError)}`
            );
          }
        } else {
          logActionState('failure');
        }
      }
    })
  );

  return disposables;
}

async function connectWireless(
  outputChannel: OutputChannel,
  configService: ConfigService,
  resolveAgPath: () => Promise<string | null>,
  resolveAdbPath: () => Promise<string | null>,
  initialAdbPath?: string | null
): Promise<void> {
  const connectMethods = ['IP地址和端口', 'AutoGo远程调试配对码', '无线调试配对码 (Android 11+)'];
  const debugMode = configService.debugMode;

  const selectedMethod = await vscode.window.showQuickPick(connectMethods, {
    placeHolder: '请选择连接或配对方式',
  });

  if (!selectedMethod) {
    return;
  }

  let connectionString = '';
  let adbPath = initialAdbPath ?? null;

  if (selectedMethod === 'IP地址和端口') {
    const ipAddress = await vscode.window.showInputBox({
      placeHolder: '192.168.1.100:5555',
      prompt: '请输入设备 IP 地址和连接端口（格式：IP:端口）',
    });
    if (!ipAddress) {
      return;
    }
    if (!ipAddress.includes(':') || ipAddress.includes(';')) {
      outputChannel.error('无效的IP地址格式，请使用冒号(:)作为分隔符，例如: 192.168.1.100:5555');
      return;
    }
    connectionString = ipAddress;
  } else if (selectedMethod === 'AutoGo远程调试配对码') {
    const pairingCode = await vscode.window.showInputBox({
      placeHolder: '19790 或 api.autogo.cc:19790',
      prompt: '请输入 AutoGo 服务配对码，或完整连接地址',
    });
    if (!pairingCode) {
      return;
    }
    const remoteAddress = normalizeAutoGoRemotePairingAddress(pairingCode);
    if (!remoteAddress) {
      outputChannel.error('无效的配对码格式，请输入 5 位数字或完整连接地址（host:端口）');
      return;
    }
    await connectAutoGoRemotePairing(remoteAddress, outputChannel, configService, resolveAgPath);
    return;
  } else if (selectedMethod === '无线调试配对码 (Android 11+)') {
    await connectAndroidWirelessPairing(outputChannel, resolveAdbPath, adbPath, debugMode);
    return;
  } else {
    return;
  }

  try {
    outputChannel.success('开始连接');

    if (!adbPath) {
      adbPath = await resolveAdbPath();
      if (!adbPath) {
        outputChannel.error('连接失败');
        return;
      }
    }

    if (!connectionString) {
      outputChannel.error('无法确定连接地址。');
      outputChannel.error('连接失败');
      return;
    }

    const connectSuccess = await attemptAdbConnection(connectionString, adbPath, outputChannel, configService);
    if (connectSuccess) {
      outputChannel.success('连接结束');
      outputChannel.success(`已选择设备: ${connectionString}`);
    } else {
      outputChannel.error('连接失败');
    }
  } catch (error) {
    const errorMsg = `连接设备时发生异常: ${error instanceof Error ? error.message : String(error)}`;
    outputChannel.error(errorMsg);
    outputChannel.error('连接失败');
  }
}

async function connectAndroidWirelessPairing(
  outputChannel: OutputChannel,
  resolveAdbPath: () => Promise<string | null>,
  initialAdbPath: string | null,
  debugMode: boolean
): Promise<void> {
  const adbPath = initialAdbPath ?? await resolveAdbPath();
  if (!adbPath) {
    outputChannel.error('连接失败');
    return;
  }

  outputChannel.success('开始连接');
  outputChannel.info('正在等待无线调试配对服务（在设备上打开“无线调试 > 使用配对码配对设备”）');

  const pairingAddressResult = await waitForAdbPairingAddress(adbPath, outputChannel, debugMode);
  if (pairingAddressResult.status === 'cancelled') {
    outputChannel.success('已取消连接');
    return;
  }
  if (pairingAddressResult.status === 'timeout') {
    outputChannel.error('等待无线调试配对服务超时（确认设备已打开“无线调试 > 使用配对码配对设备”后重试。）');
    outputChannel.error('连接失败');
    return;
  }
  const pairingAddress = pairingAddressResult.address;

  const pairingCode = await vscode.window.showInputBox({
    placeHolder: '123456',
    prompt: `请输入设备上显示的无线调试配对码（配对地址：${pairingAddress}）`,
  });
  if (!pairingCode) {
    outputChannel.success('已取消连接');
    return;
  }
  if (!/^\d{5,6}$/.test(pairingCode)) {
    outputChannel.error('无效的配对码格式，请输入5或6位数字。');
    outputChannel.error('连接失败');
    return;
  }

  const pairSuccess = await runAdbPair(adbPath, pairingAddress, pairingCode, outputChannel, debugMode);
  if (!pairSuccess) {
    outputChannel.error('连接失败');
    return;
  }

  outputChannel.info('如果设备列表没有显示该无线设备，在设备上重新开关“无线调试”后等待设备自动连接。');
  outputChannel.success('连接结束');
}

async function waitForAdbPairingAddress(
  adbPath: string,
  outputChannel: OutputChannel,
  debugMode: boolean
): Promise<
  | { status: 'found'; address: string }
  | { status: 'cancelled' }
  | { status: 'timeout' }
> {
  if (debugMode) {
    outputChannel.log('正在等待无线调试配对服务...');
  }

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: '正在等待无线调试配对服务',
      cancellable: true,
    },
    async (progress, token) => {
      progress.report({ message: '请在设备上打开“无线调试 > 使用配对码配对设备”' });
      const deadline = Date.now() + ADB_PAIRING_SERVICE_WAIT_TIMEOUT_MS;

      while (!token.isCancellationRequested && Date.now() < deadline) {
        const remainingMs = deadline - Date.now();
        const discoveredPairingAddresses = await discoverAdbPairingAddresses(
          adbPath,
          outputChannel,
          debugMode,
          token,
          remainingMs
        );
        if (discoveredPairingAddresses.length > 0) {
          const pairingAddress = discoveredPairingAddresses[0];
          if (debugMode) {
            outputChannel.log(`已发现无线调试配对服务: ${pairingAddress}`);
          }
          return { status: 'found', address: pairingAddress };
        }

        const nextRemainingMs = deadline - Date.now();
        if (nextRemainingMs > 0) {
          await delay(Math.min(1000, nextRemainingMs), token);
        }
      }

      return token.isCancellationRequested ? { status: 'cancelled' } : { status: 'timeout' };
    }
  );
}

async function discoverAdbPairingAddresses(
  adbPath: string,
  outputChannel: OutputChannel,
  debugMode: boolean,
  token?: vscode.CancellationToken,
  timeoutMs?: number
): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    if (token?.isCancellationRequested) {
      resolve([]);
      return;
    }

    const mdnsProcess = child_process.spawn(adbPath, ['mdns', 'services'], { shell: false });
    let outputData = '';
    let errorData = '';
    let settled = false;
    let cancellationDisposable: vscode.Disposable | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (addresses: string[]) => {
      if (settled) {
        return;
      }
      settled = true;
      cancellationDisposable?.dispose();
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve(addresses);
    };
    cancellationDisposable = token?.onCancellationRequested(() => {
      mdnsProcess.kill();
      finish([]);
    });
    if (typeof timeoutMs === 'number' && timeoutMs > 0) {
      timeout = setTimeout(() => {
        mdnsProcess.kill();
        finish([]);
      }, timeoutMs);
    }

    mdnsProcess.stdout.on('data', (data) => {
      outputData += data.toString();
    });

    mdnsProcess.stderr.on('data', (data) => {
      errorData += data.toString();
    });

    mdnsProcess.on('close', () => {
      if (settled) {
        return;
      }
      if (debugMode && errorData.trim()) {
        outputChannel.warn(`发现无线调试配对服务时出现警告: ${errorData.trim()}`);
      }
      finish(token?.isCancellationRequested ? [] : parseAdbMdnsPairingServices(outputData));
    });

    mdnsProcess.on('error', (err) => {
      if (settled) {
        return;
      }
      if (debugMode) {
        outputChannel.warn(`启动 adb mdns services 命令失败: ${err.message}`);
      }
      finish([]);
    });
  });
}

function delay(ms: number, token: vscode.CancellationToken): Promise<void> {
  return new Promise((resolve) => {
    if (token.isCancellationRequested) {
      resolve();
      return;
    }

    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let disposable: vscode.Disposable | undefined;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (disposable) {
        disposable.dispose();
      }
      resolve();
    };

    timeout = setTimeout(finish, ms);
    disposable = token.onCancellationRequested(finish);
  });
}

async function runAdbPair(
  adbPath: string,
  pairingAddress: string,
  pairingCode: string,
  outputChannel: OutputChannel,
  debugMode: boolean
): Promise<boolean> {
  if (debugMode) {
    outputChannel.log(`执行配对命令: "${adbPath}" pair ${pairingAddress} ${pairingCode}`);
  }

  return new Promise<boolean>((resolve) => {
    const pairProcess = child_process.spawn(adbPath, ['pair', pairingAddress, pairingCode], { shell: false });
    let outputData = '';
    let errorData = '';

    pairProcess.stdout.on('data', (data) => {
      const dataStr = data.toString();
      outputChannel.appendRaw(dataStr);
      outputData += dataStr;
    });

    pairProcess.stderr.on('data', (data) => {
      const dataStr = data.toString();
      outputChannel.appendRaw(dataStr);
      errorData += dataStr;
    });

    pairProcess.on('close', (code) => {
      const combinedOutput = `${outputData}\n${errorData}`;
      if (code === 0 && combinedOutput.toLowerCase().includes('successfully paired')) {
        resolve(true);
        return;
      }

      if (!outputData.trim() && !errorData.trim()) {
        outputChannel.error(`配对命令执行失败，退出码: ${code}`);
      }
      resolve(false);
    });

    pairProcess.on('error', (err) => {
      outputChannel.error(`启动 adb pair 命令失败: ${err.message}`);
      resolve(false);
    });
  });
}

async function connectAutoGoRemotePairing(
  remoteAddress: string,
  outputChannel: OutputChannel,
  configService: ConfigService,
  resolveAgPath: () => Promise<string | null>
): Promise<void> {
  const agPath = await resolveAgPath();
  if (!agPath) {
    return;
  }

  outputChannel.success('开始连接');
  await executeCommand(agPath, ['connect', remoteAddress], outputChannel, {
    debugMode: configService.debugMode,
    commandDisplayName: 'AutoGo远程调试配对',
    configService,
  });
}

async function attemptAdbConnection(
  deviceAddress: string,
  adbPath: string,
  outputChannel: OutputChannel,
  configService: ConfigService
): Promise<boolean> {
  const debugMode = configService.debugMode;

  if (debugMode) {
    outputChannel.log('尝试先杀死并重启ADB服务以确保状态正常');
  }

  try {
    await new Promise<void>((resolve) => {
      const killProcess = child_process.spawn(`\"${adbPath}\" kill-server`, [], { shell: true });

      killProcess.on('close', () => {
        if (debugMode) {
          outputChannel.log('ADB服务已关闭');
        }
        resolve();
      });

      killProcess.on('error', (err) => {
        if (debugMode) {
          outputChannel.warn(`杀死ADB服务失败: ${err.message}`);
        }
        resolve();
      });
    });

    await new Promise<void>((resolve) => {
      const startProcess = child_process.spawn(`\"${adbPath}\" start-server`, [], { shell: true });

      startProcess.on('close', () => {
        if (debugMode) {
          outputChannel.log('ADB服务已启动');
        }
        resolve();
      });

      startProcess.on('error', (err) => {
        if (debugMode) {
          outputChannel.warn(`启动ADB服务失败: ${err.message}`);
        }
        resolve();
      });
    });
  } catch (error) {
    if (debugMode) {
      outputChannel.warn(`重置ADB服务时出错: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const connectCommand = `\"${adbPath}\" connect ${deviceAddress}`;

  if (debugMode) {
    outputChannel.log(`执行连接命令: ${connectCommand}`);
  }

  return new Promise<boolean>((resolve) => {
    const connectProcess = child_process.spawn(connectCommand, [], { shell: true });

    let outputData = '';
    connectProcess.stdout.on('data', (data) => {
      const dataStr = data.toString();
      outputChannel.appendRaw(dataStr);
      outputData += dataStr.trim();
    });

    let errorData = '';
    connectProcess.stderr.on('data', (data) => {
      const dataStr = data.toString();
      outputChannel.appendRaw(dataStr);
      errorData += dataStr.trim();
    });

    connectProcess.on('close', async (code) => {
      const lowerOutput = outputData.toLowerCase();
      if (lowerOutput.includes('connected to') || lowerOutput.includes('already connected')) {
        try {
          await vscode.workspace
            .getConfiguration(CONFIG_SECTION)
            .update('selectedDevice', deviceAddress, vscode.ConfigurationTarget.Global);
          if (debugMode) {
            outputChannel.log(`配置已更新: selectedDevice = ${deviceAddress}`);
          }
        } catch (updateError) {
          outputChannel.error(
            `更新设备配置失败: ${updateError instanceof Error ? updateError.message : String(updateError)}`
          );
        }
        resolve(true);
      } else {
        const combinedOutput = (outputData + ' ' + errorData).toLowerCase();

        if (
            combinedOutput.includes('daemon not running') ||
            combinedOutput.includes('daemon still not running') ||
            combinedOutput.includes('cannot connect to daemon')
          ) {
          if (debugMode) {
            outputChannel.warn('检测到ADB守护进程问题，尝试重启ADB服务');
          }

          try {
            await new Promise<void>((resolveRestart) => {
              const killProcess = child_process.spawn(`\"${adbPath}\" kill-server`, [], { shell: true });
              killProcess.on('close', () => resolveRestart());
              killProcess.on('error', () => resolveRestart());
            });

            await new Promise<void>((resolveRestart) => {
              const startProcess = child_process.spawn(`\"${adbPath}\" start-server`, [], { shell: true });
              startProcess.on('close', () => resolveRestart());
              startProcess.on('error', () => resolveRestart());
            });

            setTimeout(async () => {
              if (debugMode) {
                outputChannel.log('重新尝试连接...');
              }
              const retryConnectProcess = child_process.spawn(`\"${adbPath}\" connect ${deviceAddress}`, [], { shell: true });

              let retryOutput = '';
              retryConnectProcess.stdout.on('data', (data) => {
                const dataStr = data.toString();
                outputChannel.appendRaw(dataStr);
                retryOutput += dataStr.trim();
              });

              retryConnectProcess.on('close', async () => {
                if (
                  retryOutput.toLowerCase().includes('connected to') ||
                  retryOutput.toLowerCase().includes('already connected')
                ) {
                  try {
                    await vscode.workspace
                      .getConfiguration(CONFIG_SECTION)
                      .update('selectedDevice', deviceAddress, vscode.ConfigurationTarget.Global);
                  } catch (updateError) {
                    outputChannel.error(
                      `更新设备配置失败: ${updateError instanceof Error ? updateError.message : String(updateError)}`
                    );
                  }
                  resolve(true);
                } else {
                  resolve(false);
                }
              });

              retryConnectProcess.on('error', () => {
                outputChannel.error('执行连接命令失败');
                resolve(false);
              });
            }, 1000);
          } catch (restartError) {
            outputChannel.error(`重启ADB服务失败: ${restartError instanceof Error ? restartError.message : String(restartError)}`);
            resolve(false);
          }
        } else {
          let errorMessage = `连接失败 (退出码: ${code})。`;
          if (combinedOutput.includes('10060') || combinedOutput.includes('timed out')) {
            errorMessage = `无法连接到设备 ${deviceAddress} (连接超时)。\n请检查:\n1. IP/主机名是否正确\n2. 设备与电脑是否在同一网络中\n3. 设备的网络连接是否稳定\n4. 是否有防火墙阻止连接`;
          } else if (combinedOutput.includes('10061') || combinedOutput.includes('积极拒绝')) {
            errorMessage = `设备 ${deviceAddress} 拒绝连接。\n请确认:\n1. 设备已开启网络ADB调试\n2. 端口号是否正确\n3. 如有安全软件，是否阻止了ADB连接`;
          } else if (combinedOutput.includes('failed to connect') || combinedOutput.includes('bad port number')) {
            errorMessage = `连接到设备 ${deviceAddress} 失败。\n可能原因:\n1. 连接参数不正确\n2. 设备未开启网络ADB调试\n3. 端口号格式错误\n\n请尝试:\n- 使用 adb devices 命令查看已连接设备\n- 在设备上关闭并重新打开USB调试选项`;
          } else if (combinedOutput.includes('unauthorized') || combinedOutput.includes('not authorized')) {
            errorMessage = `设备 ${deviceAddress} 未授权。\n请在设备上:\n1. 查看是否有授权提示并点击\"允许\"\n2. 如无提示，请在开发者选项中撤销USB调试授权后重试\n3. 重启设备后再次尝试连接`;
          } else if (combinedOutput.includes('offline')) {
            errorMessage = `设备 ${deviceAddress} 处于离线状态。\n建议:\n1. 断开并重新连接设备\n2. 重启设备\n3. 更换USB端口或数据线\n4. 如为无线连接，检查网络连接是否稳定`;
          } else if (errorData) {
            errorMessage += `\n错误信息: ${errorData}\n\n建议尝试:\n- 重新启动ADB服务\n- 重启设备\n- 检查设备的开发者选项设置`;
          } else if (outputData) {
            errorMessage += `\n输出信息: ${outputData}\n\n建议尝试:\n- 重新启动ADB服务\n- 重启设备\n- 检查设备的开发者选项设置`;
          }
          outputChannel.error(errorMessage);
          resolve(false);
        }
      }
    });

    connectProcess.on('error', (err) => {
      outputChannel.error(`启动 adb connect 命令失败: ${err.message}`);
      resolve(false);
    });
  });
}
