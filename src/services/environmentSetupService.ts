import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as child_process from 'child_process';
import { OutputChannel } from './outputChannel';
import { ConfigService } from './configService'; // Assuming needed, add if required
import { ensureLogViewVisible } from '../extension/views/logViewVisibility'; // Import from extension.ts
import { Downloader } from '../app/ports/downloader';
import { FileSystem } from '../app/ports/fileSystem';
import { ZipExtractor } from '../app/ports/zipExtractor';
import { createAdbPathInjectedEnv } from '../utils/adbPathEnv';

export interface NdkDownloadDeps {
    downloader: Downloader;
    zipExtractor: ZipExtractor;
    fileSystem: FileSystem;
}



// --- NDK Setup --- 

/**
 * 检查并设置 Android NDK 环境（仅在初始化时调用）
 * 检查顺序：
 * 1. 检查 ANDROID_NDK_HOME 环境变量
 * 2. 检查固定目录（Windows: C:\Users\Public, macOS: /Users/Shared）
 * 3. 如果都无效，提示用户是否下载安装
 * 
 * 注意：AutoGo SDK 已内置 NDK 检查，执行编译相关命令时会自动检查并下载
 */
export async function checkAndSetupAndroidNDK(outputChannel: OutputChannel, ndkDeps: NdkDownloadDeps, context: vscode.ExtensionContext, preference: 'Panel' | 'View' | 'None', configService: ConfigService) {
    const debugMode = configService.debugMode;

    try {
        const platform = os.platform();

        // 只支持Windows和macOS
        if (platform !== 'win32' && platform !== 'darwin') {
            if (debugMode) {
                outputChannel.log(`不支持的操作系统: ${platform}，仅支持Windows和macOS。`);
            }
            return;
        }

        // 1. 首先检查环境变量 ANDROID_NDK_HOME
        const envNdkHome = process.env.ANDROID_NDK_HOME;
        if (envNdkHome) {
            const envNdkValid = await validateNDKDirectory(envNdkHome, outputChannel, debugMode);
            if (envNdkValid) {
                outputChannel.success(`Android NDK（环境变量）: ${envNdkHome}`);
                return;
            } else if (debugMode) {
                outputChannel.log(`环境变量 ANDROID_NDK_HOME 指向的路径无效: ${envNdkHome}`);
            }
        }

        // 2. 检查固定的NDK安装目录
        const ndkBaseDir = platform === 'win32' ? 'C:\\Users\\Public' : '/Users/Shared';
        const ndkDir = path.join(ndkBaseDir, 'android-ndk-r27c');

        const ndkValid = await validateNDKDirectory(ndkDir, outputChannel, debugMode);

        if (ndkValid) {
            outputChannel.success(`Android NDK已安装: ${ndkDir}`);
            // 设置环境变量供后续使用
            process.env.ANDROID_NDK_HOME = ndkDir;
            return;
        }

        // 3. 未检测到有效的NDK，提示用户是否安装
        outputChannel.warn('未检测到有效的Android NDK安装。');

        const setupChoice = await vscode.window.showInformationMessage(
            '未检测到Android NDK，是否下载并安装？',
            '下载并安装',
            '稍后再说'
        );

        if (setupChoice === '下载并安装') {
            await downloadAndSetupAndroidNDKInternal(outputChannel, ndkDeps, context, preference, configService);
        }
    } catch (error) {
        outputChannel.error(`检查Android NDK环境时出错: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * 验证NDK目录是否有效
 * @param ndkDir NDK目录路径
 * @param outputChannel 输出通道
 * @param debugMode 调试模式
 * @returns 是否有效
 */
async function validateNDKDirectory(ndkDir: string, outputChannel: OutputChannel, debugMode: boolean): Promise<boolean> {
    if (!fs.existsSync(ndkDir)) {
        if (debugMode) {
            outputChannel.log(`NDK目录不存在: ${ndkDir}`);
        }
        return false;
    }

    // 检查NDK关键文件和目录
    const requiredPaths = [
        'toolchains/llvm/prebuilt',
        'build/cmake',
        'sources/android'
    ];

    for (const requiredPath of requiredPaths) {
        const fullPath = path.join(ndkDir, requiredPath);
        if (!fs.existsSync(fullPath)) {
            if (debugMode) {
                outputChannel.log(`NDK缺少必要组件: ${fullPath}`);
            }
            return false;
        }
    }

    return true;
}

async function checkExistingNDKPackage(
    fileSystem: FileSystem,
    targetPath: string,
    outputChannel: OutputChannel,
    debugMode: boolean,
): Promise<string | null> {
    const targetFileName = path.basename(targetPath);

    try {
        if (await fileSystem.exists(targetPath)) {
            const fileStats = await fileSystem.stat(targetPath);
            const fileSizeMB = (fileStats.size / 1048576).toFixed(2);

            if (debugMode) {
                outputChannel.log(`发现目标文件: ${targetFileName} (${fileSizeMB} MB)`);
            }

            return targetPath;
        }

        return null;
    } catch (error) {
        if (debugMode) {
            outputChannel.error(`检查现有文件时出错: ${error instanceof Error ? error.message : String(error)}`);
        }
        return null;
    }
}

async function downloadFileWithProgress(
    downloader: Downloader,
    fileSystem: FileSystem,
    outputChannel: OutputChannel,
    url: string,
    targetPath: string,
): Promise<boolean> {
    const progressOptions = {
        location: vscode.ProgressLocation.Notification,
        title: `下载 ${path.basename(targetPath)}`,
        cancellable: true,
    };

    const controller = new AbortController();
    const tmpPath = `${targetPath}.tmp`;

    try {
        await vscode.window.withProgress(progressOptions, async (progress, token) => {
            let lastReportTime = Date.now();
            let lastPercent = 0;
            const startTime = Date.now();

            token.onCancellationRequested(() => {
                outputChannel.warn('用户取消下载');
                controller.abort();
            });

            await downloader.download(url, targetPath, {
                signal: controller.signal,
                onProgress: ({ transferredBytes, totalBytes }) => {
                    if (!totalBytes) {
                        return;
                    }
                    const now = Date.now();
                    if (now - lastReportTime < 500) {
                        return;
                    }
                    lastReportTime = now;
                    const percent = Math.round((transferredBytes / totalBytes) * 100);
                    const increment = percent - lastPercent;
                    lastPercent = percent;

                    const elapsedTime = (now - startTime) / 1000;
                    const downloadSpeed = transferredBytes / elapsedTime / 1048576;
                    const remainingBytes = totalBytes - transferredBytes;
                    const remainingTime = downloadSpeed > 0 ? remainingBytes / downloadSpeed / 1048576 : 0;

                    const downloadedMB = (transferredBytes / 1048576).toFixed(2);
                    const totalMB = (totalBytes / 1048576).toFixed(2);
                    const speedText = downloadSpeed > 0 ? `${downloadSpeed.toFixed(2)} MB/s` : '计算中...';
                    const timeText = remainingTime > 0 ? `剩余 ${Math.ceil(remainingTime)}秒` : '即将完成';

                    const message = `已下载${downloadedMB}/${totalMB} MB (${percent}%) - ${speedText} - ${timeText}`;
                    progress.report({ message, increment: Math.max(0, increment) });
                },
            });
        });

        outputChannel.success(`下载完成: ${path.basename(targetPath)}`);
        return true;
    } catch (error) {
        if (await fileSystem.exists(tmpPath)) {
            await fileSystem.unlink(tmpPath);
        }
        if (controller.signal.aborted) {
            return false;
        }
        outputChannel.error(`下载错误: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}

async function extractArchive(
    zipExtractor: ZipExtractor,
    outputChannel: OutputChannel,
    zipFilePath: string,
    extractDir: string,
): Promise<boolean> {
    const progressOptions = {
        location: vscode.ProgressLocation.Notification,
        title: `解压 ${path.basename(zipFilePath)}`,
        cancellable: false,
    };

    try {
        await vscode.window.withProgress(progressOptions, async (progress) => {
            progress.report({ message: '正在解压，请稍候...' });
            await zipExtractor.extract(zipFilePath, extractDir);
        });
        return true;
    } catch (error) {
        outputChannel.error(`解压失败: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}

async function downloadAndSetupAndroidNDKInternal(outputChannel: OutputChannel, ndkDeps: NdkDownloadDeps, context: vscode.ExtensionContext, preference: 'Panel' | 'View' | 'None', configService: ConfigService) {
    ensureLogViewVisible(context, preference);
    outputChannel.success('准备下载并安装Android NDK...');

    const platform = os.platform();

    // 设置固定的下载地址和安装目录
    let downloadUrl = '';
    let fileName = '';
    let installDir = '';

    if (platform === 'win32') {
        fileName = 'android-ndk-r27c-windows.zip';
        downloadUrl = 'https://dl.google.com/android/repository/android-ndk-r27c-windows.zip';
        installDir = 'C:\\Users\\Public\\android-ndk-r27c';
    } else if (platform === 'darwin') {
        fileName = 'android-ndk-r27c-darwin.zip';
        downloadUrl = 'https://dl.google.com/android/repository/android-ndk-r27c-darwin.zip';
        installDir = '/Users/Shared/android-ndk-r27c';
    } else {
        outputChannel.error(`不支持的操作系统: ${platform}`);
        return;
    }

    const baseDir = platform === 'win32' ? 'C:\\Users\\Public' : '/Users/Shared';
    const downloadPath = path.join(baseDir, fileName);

    try {
        // 检查是否已存在NDK目录
        if (fs.existsSync(installDir)) {
            const overwriteChoice = await vscode.window.showWarningMessage(
                `NDK目录已存在: ${installDir}，是否覆盖？`,
                '覆盖',
                '取消'
            );

            if (overwriteChoice !== '覆盖') {
                outputChannel.warn('用户取消安装。');
                return;
            }

            try {
                await fs.promises.rm(installDir, { recursive: true, force: true });
                outputChannel.log(`已删除现有目录: ${installDir}`);
            } catch (error) {
                outputChannel.error(`无法删除已存在的目录: ${error instanceof Error ? error.message : String(error)}`);
                return;
            }
        }

        // 检查是否已存在NDK压缩包
        const existingPackage = await checkExistingNDKPackage(ndkDeps.fileSystem, downloadPath, outputChannel, configService.debugMode);
        let finalDownloadPath = downloadPath;
        let useExistingFile: string | undefined = undefined;

        if (existingPackage) {
            const fileStats = fs.statSync(existingPackage);
            const fileSizeMB = (fileStats.size / 1048576).toFixed(2);

            outputChannel.log(`发现已存在的文件: ${path.basename(existingPackage)} (${fileSizeMB} MB)`);

            // 询问用户是否使用现有文件
            useExistingFile = await vscode.window.showInformationMessage(
                `发现已存在的NDK压缩包 (${fileSizeMB} MB)，是否使用现有文件？`,
                { modal: true },
                '使用现有文件',
                '重新下载'
            );

            if (useExistingFile === '使用现有文件') {
                finalDownloadPath = existingPackage;
                outputChannel.success(`使用现有压缩包: ${path.basename(existingPackage)}`);
            } else if (useExistingFile === '重新下载') {
                // 删除现有文件，重新下载
                try {
                    fs.unlinkSync(existingPackage);
                    outputChannel.log(`已删除现有文件，开始重新下载: ${path.basename(existingPackage)}`);
                } catch (error) {
                    outputChannel.error(`删除现有文件失败: ${error instanceof Error ? error.message : String(error)}`);
                    return;
                }

                // 下载NDK
                const downloadSuccess = await downloadFileWithProgress(ndkDeps.downloader, ndkDeps.fileSystem, outputChannel, downloadUrl, downloadPath);
                if (!downloadSuccess) {
                    outputChannel.error('下载NDK失败');
                    return;
                }
            } else {
                // 用户取消了操作
                outputChannel.warn('用户取消安装');
                return;
            }
        } else {
            // 下载NDK
            const downloadSuccess = await downloadFileWithProgress(ndkDeps.downloader, ndkDeps.fileSystem, outputChannel, downloadUrl, downloadPath);
            if (!downloadSuccess) {
                outputChannel.error('下载NDK失败');
                return;
            }
        }

        if (existingPackage && useExistingFile === '使用现有文件') {
            outputChannel.log('准备解压现有压缩包...');
        } else if (existingPackage && useExistingFile === '重新下载') {
            outputChannel.success('下载完成，准备解压...');
        } else {
            outputChannel.success('下载完成，准备解压...');
        }

        // 解压NDK到固定目录
        const extractSuccess = await extractArchive(ndkDeps.zipExtractor, outputChannel, finalDownloadPath, baseDir);
        if (!extractSuccess) {
            outputChannel.error('解压NDK失败');
            return;
        }

        // outputChannel.success('解压完成，验证安装...');

        // 验证安装是否成功
        const isValid = await validateNDKDirectory(installDir, outputChannel, configService.debugMode);
        if (!isValid) {
            outputChannel.error('NDK安装验证失败，请检查下载的文件是否完整。');
            return;
        }

        // 设置环境变量供当前进程使用
        process.env.ANDROID_NDK_HOME = installDir;

        outputChannel.success(`Android NDK安装成功: ${installDir}`);
        vscode.window.showInformationMessage('Android NDK已成功安装。', '确定');

        // 询问是否删除下载的压缩文件
        const deleteChoice = await vscode.window.showInformationMessage(
            '是否删除下载的压缩文件以节省空间？',
            '删除',
            '保留'
        );

        if (deleteChoice === '删除') {
            try {
                await fs.promises.unlink(downloadPath);
                outputChannel.success(`已删除压缩文件: ${downloadPath}`);
            } catch (error) {
                outputChannel.warn(`删除压缩文件失败: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

    } catch (error) {
        outputChannel.error(`安装Android NDK过程中出错: ${error instanceof Error ? error.message : String(error)}`);
        vscode.window.showErrorMessage('安装Android NDK失败，请查看输出日志获取详细信息。');
    }
}

// --- Go Env Setup ---

export async function checkAndInstallGoExtension(outputChannel: OutputChannel, configService: ConfigService) { // Added configService
    const debugMode = configService.debugMode;
    // outputChannel.info('正在检查 Go 语言扩展...'); // Add general info log

    const goExtension = vscode.extensions.getExtension('golang.go');

    if (goExtension) {
        if (!goExtension.isActive) {
            if (debugMode) {
                outputChannel.log('正在激活 Go 语言扩展...');
            }
            try {
                await goExtension.activate();
                outputChannel.success('Go 语言扩展已激活。');
            } catch (err) {
                outputChannel.error(`激活 Go 语言扩展失败: ${err instanceof Error ? err.message : String(err)}`);
                // Optionally, show an error message to the user
                vscode.window.showErrorMessage('无法激活 Go 语言扩展，请检查其状态。');
                return; // Exit if activation fails
            }
        } else {
            outputChannel.success('Go 语言扩展已安装并激活。'); // Changed level to success
        }
        // After ensuring the extension is active, check the Go installation itself
        await checkGoInstallation(outputChannel, configService); // Pass configService
    } else {
        outputChannel.warn('未安装 Go 语言扩展 (golang.go)，建议安装以获得更好的开发体验。'); // Use warn level
        const installChoice = await vscode.window.showInformationMessage(
            '推荐安装官方 Go 语言扩展 (golang.go) 以获得完整功能。是否立即安装？',
            '安装',
            '稍后'
        );

        if (installChoice === '安装') {
            try {
                await vscode.commands.executeCommand('workbench.extensions.installExtension', 'golang.go');
                outputChannel.success('Go 语言扩展安装成功，请重启VS Code以完全激活。');
                // Consider prompting for reload
                vscode.window.showInformationMessage('Go 语言扩展已安装，建议重启 VS Code 以确保完全激活。', '立即重启').then(selection => {
                    if (selection === '立即重启') {
                        vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                });
            } catch (error) {
                outputChannel.error(`安装 Go 语言扩展失败: ${error instanceof Error ? error.message : String(error)}`);
                vscode.window.showErrorMessage('安装 Go 语言扩展时出错，请稍后重试或手动安装。');
            }
        }
    }
}

export async function checkAutoGOVersion(agPath: string | null, outputChannel: OutputChannel, configService: ConfigService): Promise<boolean> {
    const debugMode = configService.debugMode;

    if (!agPath) {
        return false;
    }

    // 获取AutoGO可执行文件路径
    const resolvedAgPath = agPath;

    try {
        // 检查文件是否存在
        if (!require('fs').existsSync(resolvedAgPath)) {
            // 静默返回，避免与getAgPath函数重复输出错误信息
            return false;
        }

        let versionOutput = '';

        const adbEnvResult = createAdbPathInjectedEnv(configService.adbPath);
        if (debugMode && adbEnvResult.injected) {
            outputChannel.log(`[Debug] Temporarily prepending ADB directory to PATH: ${adbEnvResult.adbDir}`);
        }

        // 执行版本命令
        const process = require('child_process').spawn(`"${resolvedAgPath}"`, ['version'], {
            env: adbEnvResult.env,
            shell: true,
            windowsHide: true
        });

        process.stdout.on('data', (data: Buffer) => {
            versionOutput += data.toString();
        });

        process.stderr.on('data', (data: Buffer) => {
            if (debugMode) {
                outputChannel.log(`[AutoGO version stderr]: ${data.toString().trim()}`);
            }
        });

        const exitCode = await new Promise<number | null>((resolve) => {
            process.on('close', resolve);
            process.on('error', (err: Error) => {
                outputChannel.error(`执行 AutoGo 版本命令失败: ${err.message}`);
                resolve(null);
            });
        });

        if (exitCode === 0 && versionOutput) {
            outputChannel.success(`AutoGo 版本: ${versionOutput.trim()}`);
            return true;
        } else if (exitCode !== 0 && exitCode !== null) {
            outputChannel.error(`AutoGo 版本命令执行失败，退出码: ${exitCode}`);
            return false;
        } else {
            // Error was already logged by the 'error' event handler
            return false;
        }

    } catch (error) {
        outputChannel.error(`检查 AutoGo 版本时发生意外错误: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}

export async function checkGoInstallation(outputChannel: OutputChannel, configService: ConfigService) { // Added configService
    const debugMode = configService.debugMode;
    // outputChannel.info('正在检查 Go 环境...'); // Add general info log

    try {
        const command = 'go';
        const args = ['version'];
        let goVersionOutput = '';

        const process = child_process.spawn(command, args);

        process.stdout.on('data', (data) => {
            goVersionOutput += data.toString();
        });

        process.stderr.on('data', (data) => {
            if (debugMode) {
                // Log stderr only in debug mode unless it's a fatal error
                outputChannel.log(`[go version stderr]: ${data.toString().trim()}`);
            }
        });

        const exitCode = await new Promise<number | null>((resolve) => {
            process.on('close', resolve);
            process.on('error', (err) => {
                // This handles errors like EACCES or ENOENT (command not found)
                outputChannel.error(`执行 'go version' 失败: ${err.message}`);
                resolve(null); // Indicate failure
            });
        });

        if (exitCode === 0 && goVersionOutput) {
            outputChannel.success(`Go 环境已安装: ${goVersionOutput.trim()}`);
        } else if (exitCode !== 0 && exitCode !== null) {
            outputChannel.error(`'go version' 命令执行失败，退出码: ${exitCode}. 请确保 Go 已正确安装并配置在 PATH 中。`);
            showGoInstallationError();
        } else if (exitCode === null) {
            // Error was already logged by the 'error' event handler
            showGoInstallationError();
        }

    } catch (error) {
        // Catch any unexpected errors during the setup/check
        outputChannel.error(`检查 Go 安装时发生意外错误: ${error instanceof Error ? error.message : String(error)}`);
        showGoInstallationError();
    }
}

function showGoInstallationError() {
    // Use backticks for the template literal to avoid issues with single quotes inside
    vscode.window.showErrorMessage(`未找到有效的 Go 安装或执行 'go version' 出错。请确保 Go 已安装并添加到系统 PATH 环境变量中。`, '查看 Go 安装文档').then(selection => {
        if (selection === '查看 Go 安装文档') {
            vscode.env.openExternal(vscode.Uri.parse('https://golang.org/doc/install'));
        }
    });
}
