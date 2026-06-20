import * as child_process from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AdbService } from '../../../services/adbService';
import { IosDebugService } from '../../../services/iosDebugService';
import { ConfigService, CONFIG_SECTION } from '../../../services/configService';
import { NdkDownloadDeps } from '../../../services/environmentSetupService';
import { OutputChannel } from '../../../services/outputChannel';
import { getRunCommandRunning, setRunCommandRunning } from '../../../services/runCommandState';
import { executeCommand } from '../../../utils/processUtils';
import {
    USER_MESSAGES,
    formatArtifactNotFound,
    formatDeviceNotConnected,
} from '../../../utils/userMessages';
import { ensureLogViewVisible } from '../../views/logViewVisibility';
import { checkDeviceConnection } from '../shared/deviceConnection';
import { resolveAdbPathForCommand } from '../../adbPathResolver';
import { iosConnectionManager } from '../../../infra/ios/connectionManager';
import { registerCompileAmd64Command } from './compileAmd64';
import { registerCompileAmdCommand } from './compileAmd';
import { registerCompileApkCommand } from './compileApk';
import { registerCompileArm64Command } from './compileArm64';
import { buildAgBuildArgs } from './buildCommandArgs';
import { registerCompileDEBCommand } from './compileDeb';
import { registerCompileIOSCommand } from './compileIos';
import { registerCompileIPACommand } from './compileIpa';
import { registerQuickDebugMainGoCommand } from './quickDebugMainGo';
import { registerRunCustomCommandCommand } from './runCustomCommand';
import { registerRunCustomFileCommand } from './runCustomFile';
import { registerRunCustomUrlCommand } from './runCustomUrl';
import { registerRunCommand } from './runProject';
import { registerStopCommand } from './stopProject';

export interface RunCommandDeps {
    context: vscode.ExtensionContext;
    outputChannel: OutputChannel;
    configService: ConfigService;
    ndkDeps: NdkDownloadDeps;
    adbService: AdbService;
    iosDebugService: IosDebugService;
    getAgPath: () => string | null;
    getLogViewPreference: () => 'Panel' | 'View' | 'None';
}

export function registerRunCommands(deps: RunCommandDeps): vscode.Disposable[] {
    const {
        context,
        outputChannel,
        configService,
        ndkDeps,
        adbService,
        iosDebugService,
        getAgPath,
        getLogViewPreference,
    } = deps;

    const disposables: vscode.Disposable[] = [];
    const iosDeviceStateKey = 'autogo.selectedIosDevice';
    type RunCommandLockResult = 'keep-running' | void;
    const logIosFlow = (
        message: string,
        level: 'log' | 'success' | 'warn' | 'error' = 'log'
    ): void => {
        switch (level) {
            case 'success':
                outputChannel.success(message);
                break;
            case 'warn':
                outputChannel.warn(message);
                break;
            case 'error':
                outputChannel.error(message);
                break;
            default:
                outputChannel.log(message);
                break;
        }
    };
    const logActionState = (
        action: '运行' | '调试' | '停止',
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

    const selectIosDevice = async (
        placeHolder: string
    ): Promise<string | null> => {
        const devices = iosConnectionManager.getAllDevices();
        if (devices.length === 0) {
            logIosFlow(USER_MESSAGES.noIosDeviceConnected, 'warn');
            return null;
        }

        const preferredHost = context.globalState.get<string>(iosDeviceStateKey, '').trim() || configService.selectedDevice.trim();
        if (preferredHost) {
            const matchedDevice = devices.find((device) => device.id === preferredHost);
            if (matchedDevice) {
                return matchedDevice.id;
            }
        }

        const selected = await vscode.window.showQuickPick(
            devices.map((d) => ({
                label: d.id,
                description: `连接于 ${d.connectedAt.toLocaleString()}`,
                host: d.id,
            })),
            { placeHolder }
        );

        if (!selected) {
            return null;
        }

        await context.globalState.update(iosDeviceStateKey, selected.host);
        return selected.host;
    };

    const withRunCommandLock = (
        handler: (...args: unknown[]) => Promise<RunCommandLockResult>
    ): ((...args: unknown[]) => Promise<void>) => {
        return async (...args) => {
            if (getRunCommandRunning()) {
                return;
            }

            setRunCommandRunning(true);
            let keepRunState = false;
            try {
                keepRunState = await handler(...args) === 'keep-running';
            } finally {
                if (!keepRunState) {
                    setRunCommandRunning(false);
                }
            }
        };
    };

    disposables.push(
        registerRunCommand(withRunCommandLock(async (...args) => {
            ensureLogViewVisible(context, getLogViewPreference());

            // iOS 平台使用 TCP 协议
            if (configService.targetPlatform === 'ios') {
                await runOnIosDevice();
                return;
            }

            // Android 平台使用原有逻辑
            logActionState('运行', 'start');
            const agPath = getAgPath();
            if (!agPath) return;
            const debugMode = configService.debugMode;

            let targetDevice = '';
            if (args.length > 0 && typeof args[0] === 'string' && !args[0].startsWith('file:')) {
                targetDevice = args[0];
            } else {
                targetDevice = configService.selectedDevice;
            }

            if (!targetDevice) {
                const message = USER_MESSAGES.deviceNotSelected;
                outputChannel.error(message);
                return;
            }

            try {
                const devices = await adbService.getDevices();
                if (debugMode) {
                    outputChannel.success(`可用设备: ${devices.join(', ')}`);
                }

                if (!devices.includes(targetDevice)) {
                    const message = formatDeviceNotConnected(targetDevice);
                    outputChannel.error(message);
                    return;
                }
            } catch (error) {
                if (debugMode) {
                    outputChannel.warn(
                        `检查设备连接状态时出错: ${error instanceof Error ? error.message : String(error)}，将尝试默认设备运行`
                    );
                }
            }

            const command = targetDevice ? `"${agPath}" run ${targetDevice}` : `"${agPath}" run`;
            if (debugMode) {
                outputChannel.success(`执行命令: ${command}`);
            }

            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                outputChannel.error(USER_MESSAGES.workspaceNotFound);
                return;
            }
            const cwd = workspaceFolders[0].uri.fsPath;

            try {
                const runArgs = ['run'];
                if (targetDevice) {
                    runArgs.push('-s', targetDevice);
                }

                const result = await executeCommand(
                    agPath,
                    runArgs,
                    outputChannel,
                    {
                        cwd: cwd,
                        debugMode: debugMode,
                        commandDisplayName: '运行',
                        timeout: 0,
                        configService: configService,
                    }
                );

                if (!result.success) {
                    logActionState('运行', 'failure');
                    return;
                }

                logActionState('运行', 'success');
            } catch (error) {
                logActionState('运行', 'failure');
                if (debugMode) {
                    const errorMsg = `执行运行命令时发生未预料的异常: ${error instanceof Error ? error.message : String(error)}`;
                    outputChannel.error(errorMsg);
                }
            }

            async function runOnIosDevice(): Promise<RunCommandLockResult> {
                const selectedHost = await selectIosDevice('选择要运行的 iOS 设备');
                if (!selectedHost) {
                    return;
                }

                logActionState('运行', 'start');
                const compileSucceeded = await compileBuildTarget(
                    {
                        context,
                        outputChannel,
                        configService,
                        getAgPath,
                        getLogViewPreference,
                    },
                    {
                        target: 'ios',
                        commandDisplayName: 'iOS 二进制',
                        failureMessage: 'iOS 二进制命令执行失败。请查看上面的日志获取详细信息。',
                        unexpectedErrorPrefix: '执行 iOS 二进制命令时发生未预料的异常',
                    }
                );
                if (!compileSucceeded) {
                    logActionState('运行', 'failure');
                    return;
                }

                // 查找编译产物
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (!workspaceFolders) {
                    logIosFlow(USER_MESSAGES.workspaceNotFound, 'error');
                    return;
                }

                const workspaceRoot = workspaceFolders[0].uri.fsPath;
                const buildDir = path.join(workspaceRoot, 'build');

                // 二进制模式
                const binaryPath = path.join(buildDir, 'ios-release');
                if (!fs.existsSync(binaryPath)) {
                    logIosFlow(formatArtifactNotFound(binaryPath), 'error');
                    return;
                }

                const success = await iosDebugService.runBinary(
                    selectedHost,
                    binaryPath,
                    () => {
                        logActionState('运行', 'success');
                        setRunCommandRunning(false);
                    }
                );
                if (success) {
                    return 'keep-running';
                }

                logActionState('运行', 'failure');
            }
        })),
        registerStopCommand(async () => {
            ensureLogViewVisible(context, getLogViewPreference());

            // iOS 平台使用 TCP 协议
            if (configService.targetPlatform === 'ios') {
                await stopIosDevice();
                return;
            }

            // Android 平台使用原有逻辑
            logActionState('停止', 'start');
            const agPath = getAgPath();
            if (!agPath) return;
            const debugMode = configService.debugMode;

            const selectedDevice = configService.selectedDevice;
            let useDefaultDevice = false;

            if (selectedDevice) {
                const connectionStatus = await checkDeviceConnection(adbService, outputChannel, selectedDevice, configService);
                if (connectionStatus !== 'connected') {
                    useDefaultDevice = true;
                    if (debugMode) {
                        if (connectionStatus === 'not_connected') {
                            outputChannel.warn(`设备 ${selectedDevice} 未连接，将尝试停止默认设备。`);
                        } else {
                            outputChannel.warn(`检查设备 ${selectedDevice} 连接状态失败，将尝试停止默认设备。`);
                        }
                    }
                }
            } else {
                useDefaultDevice = true;
            }

            const command = useDefaultDevice ? `"${agPath}" stop` : `"${agPath}" stop ${selectedDevice}`;

            if (debugMode) {
                outputChannel.success(`执行命令: ${command}`);
            }

            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                if (debugMode) {
                    outputChannel.warn('未找到工作区，可能无法正确定位项目。');
                }
            }
            const cwd = workspaceFolders?.[0]?.uri?.fsPath;
            if (cwd && debugMode) {
                outputChannel.success(`设置工作目录 (cwd): ${cwd}`);
            }

            try {
                const stopArgs = ['stop'];
                if (!useDefaultDevice && selectedDevice) {
                    stopArgs.push('-s', selectedDevice);
                }

                const result = await executeCommand(
                    agPath,
                    stopArgs,
                    outputChannel,
                    {
                        cwd: cwd,
                        debugMode: debugMode,
                        commandDisplayName: '停止',
                        configService: configService,
                    }
                );

                if (!result.success) {
                    logActionState('停止', 'failure');
                    return;
                }

                logActionState('停止', 'success');
            } catch (error) {
                logActionState('停止', 'failure');
                if (debugMode) {
                    const errorMsg = `执行停止命令时发生未预料的异常: ${error instanceof Error ? error.message : String(error)}`;
                    outputChannel.error(errorMsg);
                }
            }

            async function stopIosDevice(): Promise<void> {
                const selectedHost = await selectIosDevice('选择要停止脚本的 iOS 设备');
                if (!selectedHost) {
                    return;
                }

                try {
                    logActionState('停止', 'start');
                    iosDebugService.stopScript(selectedHost);
                    setRunCommandRunning(false);
                    logActionState('停止', 'success');
                } catch (error) {
                    logActionState('停止', 'failure');
                    if (configService.debugMode) {
                        const errorMsg = `执行停止命令时发生未预料的异常: ${error instanceof Error ? error.message : String(error)}`;
                        outputChannel.error(errorMsg);
                    }
                }
            }
        }),
        registerQuickDebugMainGoCommand(async (...args) => {
            ensureLogViewVisible(context, getLogViewPreference());

            // iOS 平台使用 TCP 协议进行快速调试（zip 模式）
            if (configService.targetPlatform === 'ios') {
                await quickDebugOnIos();
                return;
            }

            // Android 平台使用原有逻辑
            logActionState('调试', 'start');
            const agPath = getAgPath();
            if (!agPath) {
                return;
            }
            const debugMode = configService.debugMode;

            let targetDevice = '';
            if (args.length > 0 && typeof args[0] === 'string' && !args[0].startsWith('file:')) {
                targetDevice = args[0];
            } else {
                targetDevice = configService.selectedDevice;
            }

            if (!targetDevice) {
                const devices = await adbService.getDevices();
                if (devices.length === 1) {
                    targetDevice = devices[0];
                    await vscode.workspace.getConfiguration(CONFIG_SECTION).update('selectedDevice', targetDevice, vscode.ConfigurationTarget.Global);
                    outputChannel.success(`已选择设备: ${targetDevice}`);
                } else {
                    const message = USER_MESSAGES.deviceNotSelected;
                    outputChannel.error(message);
                    return;
                }
            }

            const connectionStatus = await checkDeviceConnection(
                adbService,
                outputChannel,
                targetDevice,
                configService
            );
            if (connectionStatus !== 'connected') {
                const message = formatDeviceNotConnected(targetDevice);
                outputChannel.error(message);
                return;
            }

            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                outputChannel.error(USER_MESSAGES.workspaceNotFound);
                return;
            }
            const cwd = workspaceFolders[0].uri.fsPath;

            try {
                const runArgs = ['run', '-s', targetDevice, '-d'];

                const result = await executeCommand(
                    agPath,
                    runArgs,
                    outputChannel,
                    {
                        cwd: cwd,
                        debugMode: debugMode,
                        commandDisplayName: '快速调试',
                        timeout: 0,
                        configService: configService,
                    }
                );

                if (!result.success) {
                    logActionState('调试', 'failure');
                    return;
                }

                logActionState('调试', 'success');
            } catch (error) {
                logActionState('调试', 'failure');
                if (debugMode) {
                    const errorMsg = `执行快速调试命令时发生未预料的异常: ${error instanceof Error ? error.message : String(error)}`;
                    outputChannel.error(errorMsg);
                }
            }

            async function quickDebugOnIos(): Promise<void> {
                const selectedHost = await selectIosDevice('选择要调试的 iOS 设备');
                if (!selectedHost) {
                    return;
                }

                logActionState('调试', 'start');

                // 执行打包（AG run -t ios 生成 ios-debug.zip）
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (!workspaceFolders) {
                    logIosFlow(USER_MESSAGES.workspaceNotFound, 'error');
                    return;
                }
                const cwd = workspaceFolders[0].uri.fsPath;
                const buildDir = path.join(cwd, 'build');
                const zipPath = path.join(buildDir, 'ios-debug.zip');

                // 先删除旧的 zip 文件确保生成新的
                if (fs.existsSync(zipPath)) {
                    fs.unlinkSync(zipPath);
                }

                const agPath = getAgPath();
                if (!agPath) {
                    return;
                }

                const result = await executeCommand(
                    agPath,
                    ['run', '-t', 'ios'],
                    outputChannel,
                    {
                        cwd: cwd,
                        debugMode: configService.debugMode,
                        commandDisplayName: 'iOS 打包',
                        timeout: 0,
                        configService: configService,
                    }
                );

                if (!result.success) {
                    logActionState('调试', 'failure');
                    return;
                }

                if (!fs.existsSync(zipPath)) {
                    logIosFlow(formatArtifactNotFound(zipPath), 'error');
                    return;
                }

                const success = await iosDebugService.quickDebug(selectedHost, zipPath);
                if (success) {
                    logActionState('调试', 'success');
                } else {
                    logActionState('调试', 'failure');
                }
            }
        }),
        registerCompileArm64Command(async () => {
            await compileProject('arm64-v8a', {
                context,
                outputChannel,
                configService,
                ndkDeps,
                getAgPath,
                getLogViewPreference,
            });
        }),
        registerCompileAmd64Command(async () => {
            await compileProject('x86_64', {
                context,
                outputChannel,
                configService,
                ndkDeps,
                getAgPath,
                getLogViewPreference,
            });
        }),
        registerCompileAmdCommand(async () => {
            await compileProject('x86', {
                context,
                outputChannel,
                configService,
                ndkDeps,
                getAgPath,
                getLogViewPreference,
            });
        }),
        registerCompileApkCommand(async () => {
            await compileProject('apk', {
                context,
                outputChannel,
                configService,
                ndkDeps,
                getAgPath,
                getLogViewPreference,
            });
        }),
        registerCompileIOSCommand(async () => {
            await compileIOSProject({
                context,
                outputChannel,
                configService,
                getAgPath,
                getLogViewPreference,
            });
        }),
        registerCompileIPACommand(async () => {
            await compileIPAProject({
                context,
                outputChannel,
                configService,
                getAgPath,
                getLogViewPreference,
            });
        }),
        registerCompileDEBCommand(async () => {
            await compileDEBProject({
                context,
                outputChannel,
                configService,
                getAgPath,
                getLogViewPreference,
            });
        }),
        registerRunCustomCommandCommand(async () => {
            const debugMode = configService.debugMode;
            if (debugMode) outputChannel.success('开始执行 AutoGo.runCustomCommand');

            const customCommands = configService.customCommands;
            if (debugMode) {
                outputChannel.success(`读取到 ${customCommands.length} 条自定义命令: ${JSON.stringify(customCommands)}`);
            }

            if (customCommands.length === 0) {
                if (debugMode) outputChannel.success('没有自定义命令，准备提示用户添加。');
                const message = '没有保存的自定义命令。是否要添加一个新命令？';
                const result = await vscode.window.showInformationMessage(message, '添加命令');
                if (result === '添加命令') {
                    vscode.commands.executeCommand('AutoGo.settings');
                }
                if (debugMode) outputChannel.success('AutoGo.runCustomCommand 执行结束（无命令）。');
                return;
            }

            const items = customCommands.map(item => ({ label: item.label, detail: item.command }));
            if (debugMode) outputChannel.success(`转换后的 QuickPick items: ${JSON.stringify(items)}`);
            if (debugMode) outputChannel.success('准备调用 showQuickPick...');

            const selectedItem = await vscode.window.showQuickPick(items, {
                placeHolder: '选择要运行的终端命令',
            });
            if (debugMode) outputChannel.success(`showQuickPick 返回: ${JSON.stringify(selectedItem)}`);

            if (!selectedItem) {
                if (debugMode) outputChannel.success('用户未选择命令，退出。');
                return;
            }

            const command = customCommands.find(item => item.label === selectedItem.label)?.command;
            if (!command) {
                if (debugMode) outputChannel.success('未找到选中项对应的命令，退出。');
                return;
            }
            outputChannel.success(`执行自定义命令: ${command}`);

            try {
                const terminal = vscode.window.createTerminal('AutoGo 自定义命令');
                terminal.show();
                terminal.sendText(command);
            } catch (error) {
                outputChannel.error(`执行命令时出错: ${error instanceof Error ? error.message : String(error)}`);
            }
            if (debugMode) outputChannel.success('AutoGo.runCustomCommand 执行完毕。');
        }),
        registerRunCustomFileCommand(async () => {
            const debugMode = configService.debugMode;
            if (debugMode) outputChannel.success('开始执行 AutoGo.runCustomFile');

            const customFiles = configService.customFiles;
            if (debugMode) {
                outputChannel.success(`读取到 ${customFiles.length} 条自定义文件: ${JSON.stringify(customFiles)}`);
            }

            if (customFiles.length === 0) {
                if (debugMode) outputChannel.success('没有自定义文件，准备提示用户添加。');
                const message = '没有保存的自定义文件应用。是否要添加一个新项？';
                const result = await vscode.window.showInformationMessage(message, '添加文件/应用');
                if (result === '添加文件/应用') {
                    vscode.commands.executeCommand('AutoGo.settings');
                }
                if (debugMode) outputChannel.success('AutoGo.runCustomFile 执行结束（无文件）。');
                return;
            }

            const items = customFiles.map(item => ({ label: item.label, detail: item.path }));
            if (debugMode) outputChannel.success(`转换后的 QuickPick items: ${JSON.stringify(items)}`);
            if (debugMode) outputChannel.success('准备调用 showQuickPick...');

            const selectedItem = await vscode.window.showQuickPick(items, {
                placeHolder: '选择要打开的文件应用',
            });
            if (debugMode) outputChannel.success(`showQuickPick 返回: ${JSON.stringify(selectedItem)}`);

            if (!selectedItem) {
                if (debugMode) outputChannel.success('用户未选择文件，退出。');
                return;
            }

            const filePath = customFiles.find(item => item.label === selectedItem.label)?.path;
            if (!filePath) {
                if (debugMode) outputChannel.success('未找到选中项对应的文件路径，退出。');
                return;
            }

            outputChannel.success(`打开文件应用: ${filePath}`);

            try {
                let openCommand = '';
                if (process.platform === 'win32') {
                    openCommand = `start "" "${filePath}"`;
                } else if (process.platform === 'darwin') {
                    openCommand = `open "${filePath}"`;
                } else {
                    openCommand = `xdg-open "${filePath}"`;
                }

                if (debugMode) outputChannel.success(`执行打开命令: ${openCommand}`);
                child_process.exec(openCommand, (error) => {
                    if (error) {
                        outputChannel.error(`打开文件应用时出错: ${error.message}`);
                    }
                });
            } catch (error) {
                outputChannel.error(`打开文件应用时出错: ${error instanceof Error ? error.message : String(error)}`);
            }
            if (debugMode) outputChannel.success('AutoGo.runCustomFile 执行完毕。');
        }),
        registerRunCustomUrlCommand(async () => {
            const debugMode = configService.debugMode;
            if (debugMode) outputChannel.success('开始执行 AutoGo.runCustomUrl');

            const customUrls = configService.customUrls;
            if (debugMode) {
                outputChannel.success(`读取到 ${customUrls.length} 条自定义URL: ${JSON.stringify(customUrls)}`);
            }

            if (customUrls.length === 0) {
                if (debugMode) outputChannel.success('没有自定义URL，准备提示用户添加。');
                const message = '没有保存的自定义URL链接。是否要添加一个新链接？';
                const result = await vscode.window.showInformationMessage(message, '添加链接');
                if (result === '添加链接') {
                    vscode.commands.executeCommand('AutoGo.settings');
                }
                if (debugMode) outputChannel.success('AutoGo.runCustomUrl 执行结束（无URL）。');
                return;
            }

            const items = customUrls.map(item => ({ label: item.label, detail: item.url }));
            if (debugMode) outputChannel.success(`转换后的 QuickPick items: ${JSON.stringify(items)}`);
            if (debugMode) outputChannel.success('准备调用 showQuickPick...');

            const selectedItem = await vscode.window.showQuickPick(items, {
                placeHolder: '选择要打开的URL链接',
            });
            if (debugMode) outputChannel.success(`showQuickPick 返回: ${JSON.stringify(selectedItem)}`);

            if (!selectedItem) {
                if (debugMode) outputChannel.success('用户未选择URL，退出。');
                return;
            }

            const url = customUrls.find(item => item.label === selectedItem.label)?.url;
            if (!url) {
                if (debugMode) outputChannel.success('未找到选中项对应的URL，退出。');
                return;
            }

            outputChannel.success(`打开URL链接: ${url}`);

            try {
                if (debugMode) outputChannel.success(`调用 vscode.env.openExternal 打开: ${url}`);
                await vscode.env.openExternal(vscode.Uri.parse(url));
            } catch (error) {
                outputChannel.error(`打开URL链接时出错: ${error instanceof Error ? error.message : String(error)}`);
            }
            if (debugMode) outputChannel.success('AutoGo.runCustomUrl 执行完毕。');
        }),
    );

    return disposables;
}


interface CompileProjectDeps {
    context: vscode.ExtensionContext;
    outputChannel: OutputChannel;
    configService: ConfigService;
    ndkDeps: NdkDownloadDeps;
    getAgPath: () => string | null;
    getLogViewPreference: () => 'Panel' | 'View' | 'None';
}

interface CompileBuildTargetOptions {
    target: string;
    startMessage?: string;
    commandDisplayName: string;
    failureMessage: string;
    unexpectedErrorPrefix: string;
    packso?: boolean;
    apkArchitectures?: Record<string, boolean>;
}

async function compileBuildTarget(
    deps: CompileIOSProjectDeps,
    options: CompileBuildTargetOptions
): Promise<boolean> {
    const { context, outputChannel, configService, getAgPath, getLogViewPreference } = deps;
    ensureLogViewVisible(context, getLogViewPreference());
    if (options.startMessage) {
        outputChannel.success(options.startMessage);
    }

    const debugMode = configService.debugMode;
    const agPath = getAgPath();
    if (!agPath) return false;

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        outputChannel.error(USER_MESSAGES.workspaceNotFound);
        return false;
    }
    const cwd = workspaceFolders[0].uri.fsPath;

    try {
        const args = buildAgBuildArgs({
            target: options.target,
            packso: options.packso,
            codeObfuscation: configService.codeObfuscation,
            apkArchitectures: options.apkArchitectures,
        });

        const result = await executeCommand(
            agPath,
            args,
            outputChannel,
            {
                cwd: cwd,
                debugMode: debugMode,
                commandDisplayName: options.commandDisplayName,
                configService: configService,
            }
        );

        if (!result.success) {
            outputChannel.error(options.failureMessage);
            return false;
        }
        return true;
    } catch (error) {
        const errorMsg = `${options.unexpectedErrorPrefix}: ${error instanceof Error ? error.message : String(error)}`;
        outputChannel.error(errorMsg);
        return false;
    }
}

async function compileProject(abi: string, deps: CompileProjectDeps): Promise<void> {
    const { configService } = deps;

    // AutoGo SDK handles NDK checks automatically when build commands run.

    await compileBuildTarget(deps, {
        target: abi,
        startMessage: `开始编译项目为 ${abi} 架构...`,
        commandDisplayName: `编译(${abi})`,
        failureMessage: `编译(${abi}) 命令执行失败。请查看上面的日志获取详细信息。`,
        unexpectedErrorPrefix: '执行编译命令时发生未预料的异常',
        packso: configService.packso,
        apkArchitectures: configService.apkArchitectures,
    });
}

interface CompileIOSProjectDeps {
    context: vscode.ExtensionContext;
    outputChannel: OutputChannel;
    configService: ConfigService;
    getAgPath: () => string | null;
    getLogViewPreference: () => 'Panel' | 'View' | 'None';
}

async function compileIOSProject(deps: CompileIOSProjectDeps): Promise<void> {
    await compileBuildTarget(deps, {
        target: 'ios',
        startMessage: '开始编译 iOS 项目...',
        commandDisplayName: 'iOS 二进制',
        failureMessage: 'iOS 二进制命令执行失败。请查看上面的日志获取详细信息。',
        unexpectedErrorPrefix: '执行 iOS 二进制命令时发生未预料的异常',
    });
}

interface CompileIPAProjectDeps {
    context: vscode.ExtensionContext;
    outputChannel: OutputChannel;
    configService: ConfigService;
    getAgPath: () => string | null;
    getLogViewPreference: () => 'Panel' | 'View' | 'None';
}

async function compileIPAProject(deps: CompileIPAProjectDeps): Promise<void> {
    await compileBuildTarget(deps, {
        target: 'ipa',
        startMessage: '开始打包 IPA...',
        commandDisplayName: 'IPA 安装包',
        failureMessage: 'IPA 安装包命令执行失败。请查看上面的日志获取详细信息。',
        unexpectedErrorPrefix: '执行 IPA 安装包命令时发生未预料的异常',
    });
}

async function compileDEBProject(deps: CompileIPAProjectDeps): Promise<void> {
    await compileBuildTarget(deps, {
        target: 'deb',
        startMessage: '开始打包 DEB...',
        commandDisplayName: 'DEB 安装包',
        failureMessage: 'DEB 安装包命令执行失败。请查看上面的日志获取详细信息。',
        unexpectedErrorPrefix: '执行 DEB 安装包命令时发生未预料的异常',
    });
}
