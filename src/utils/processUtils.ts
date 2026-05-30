import * as child_process from 'child_process';
import { OutputChannel } from '../services/outputChannel';
import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import { ConfigService } from '../services/configService';
import { type AdbPathEnvResult, createAdbPathInjectedEnv, isAgExecutableCommand } from './adbPathEnv';

// 日志级别枚举
export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARNING = 2,
    ERROR = 3
}

// 处理进程输出的配置选项
export interface ProcessOutputOptions {
    minLogLevel?: LogLevel;
    bufferSize?: number;
    timeout?: number; // Timeout in milliseconds
    stripAnsi?: boolean;
    debugMode?: boolean;
    showPrefix?: boolean; // This might be less relevant if using appendRaw primarily
    cwd?: string; // Current working directory
    shell?: boolean | string; // Whether to use shell, or specify shell path
    commandDisplayName?: string; // Optional display name for logging
    configService?: ConfigService;
    silent?: boolean; // If true, suppress stdout/stderr output
}

// 默认配置
const defaultOptions: ProcessOutputOptions = {
    minLogLevel: LogLevel.INFO,
    bufferSize: 1024 * 1024, // 1MB
    timeout: 0, // 禁用超时机制
    stripAnsi: true,
    debugMode: false,
    showPrefix: true,
    shell: true, // Default to using shell, common for AG/ADB commands
    cwd: undefined,
    commandDisplayName: undefined,
    configService: undefined,
    silent: false,
};

/**
 * 处理进程输出 (简化版)
 * 直接将原始 stdout 和 stderr 输出到 自定义的 OutputChannel
 * @param process 子进程
 * @param outputChannel 输出通道 (自定义类型)
 * @param commandName 命令名称 (用于日志)
 * @param options 配置选项 (主要用于 debugMode 和 timeout)
 */
export function handleProcessOutput(
    process: child_process.ChildProcessWithoutNullStreams,
    outputChannel: OutputChannel, // <--- 类型是我们的自定义 OutputChannel
    commandName: string,
    options: ProcessOutputOptions = {}
): void {
    const config = { ...defaultOptions, ...options };
    const debugMode = config.debugMode || false;
    const silent = config.silent || false;

    // 设置超时
    let timeoutId: NodeJS.Timeout | null = null;
    if (commandName !== "运行") {
        timeoutId = setTimeout(() => {
            // 使用 warn 记录超时
            outputChannel.warn(`[${commandName}] 执行超时 (${config.timeout}ms)，正在终止进程...`);
            process.kill();
        }, config.timeout);
    }

    // 处理标准输出 - 使用 appendRaw
    process.stdout.on('data', (data) => {
        if (!silent) {
            outputChannel.appendRaw(data.toString());
        }
    });

    // 处理标准错误 - 使用 appendRaw
    process.stderr.on('data', (data) => {
        if (!silent) {
            outputChannel.appendRaw(data.toString());
        }
    });

    // 处理进程结束 (简化)
    process.on('close', (code) => {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
        // 使用 log 记录结束信息
        if (debugMode) {
            outputChannel.log(`[${commandName}] 进程结束，退出码: ${code}`);
        } else if (code !== 0 && commandName !== "运行") { // 非运行命令且退出码非0时提示一下
            outputChannel.log(`[${commandName}] 进程结束，退出码: ${code}`);
        } else {
            // 对于成功或运行命令，不再默认打印结束信息，除非 debugMode
        }
    });

    // 处理进程错误 (保留)
    process.on('error', (err) => {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
        // 使用 error 记录启动错误
        outputChannel.error(`[${commandName}] 启动进程时出错: ${err.message}`);
    });
}

/**
 * 执行命令 (增强版)
 * Handles command execution with options for cwd, shell, timeout, and raw output.
 * Temporarily modifies PATH for AG.exe if a specific adbPath is configured.
 * @param command 命令或可执行文件路径
 * @param args 命令参数数组
 * @param outputChannel 输出通道 (自定义类型)
 * @param options 配置选项 (cwd, shell, timeout, debugMode, commandDisplayName, configService)
 * @returns Promise 包含成功状态和基于退出码或错误的消息
 */
export async function executeCommand(
    command: string,
    args: string[],
    outputChannel: OutputChannel,
    options: ProcessOutputOptions = {}
): Promise<{ success: boolean; message: string }> {
    const config = { ...defaultOptions, ...options };
    const commandName = config.commandDisplayName || command;
    const debugMode = config.debugMode || false;
    const configService = config.configService;
    const silent = config.silent || false;

    if (debugMode) {
        const fullCommand = `${command} ${args.join(' ')}`;
        outputChannel.log(`[Debug] Executing command: ${fullCommand}`);
        if (config.cwd) {
            outputChannel.log(`[Debug] Working directory: ${config.cwd}`);
        }
        if (config.shell) {
            outputChannel.log(`[Debug] Using shell: ${config.shell === true ? 'default' : config.shell}`);
        }
        if (config.timeout && commandName !== "运行") {
            outputChannel.log(`[Debug] Timeout set: ${config.timeout}ms`);
        }
    }

    const isAgCommand = isAgExecutableCommand(command);
    const adbEnvResult: AdbPathEnvResult = isAgCommand
        ? createAdbPathInjectedEnv(configService?.adbPath, process.env)
        : { env: { ...process.env }, injected: false };

    let spawnOptions: child_process.SpawnOptionsWithoutStdio = {
        cwd: config.cwd,
        shell: config.shell,
        env: adbEnvResult.env
    };

    // --- V V V 临时修改 PATH 环境变量 V V V ---
    if (isAgCommand && configService && debugMode) {
        if (adbEnvResult.injected) {
            outputChannel.log(`[Debug] Temporarily prepending ADB directory to PATH: ${adbEnvResult.adbDir}`);
        } else if (adbEnvResult.reason === 'missing-adb-dir') {
            outputChannel.warn(`[Debug] Configured ADB directory does not exist: ${adbEnvResult.adbDir}. Not modifying PATH.`);
        } else if (adbEnvResult.reason === 'path-processing-error') {
            const pathError = adbEnvResult.error;
            outputChannel.warn(`[Debug] Error processing configured ADB path for PATH modification: ${pathError instanceof Error ? pathError.message : String(pathError)}`);
        }
    }
    // --- ^ ^ ^ 临时修改 PATH 环境变量 ^ ^ ^ ---

    // --- V V V macOS架构兼容处理 V V V ---
    let originalCommand = command;
    let originalArgs = [...args];

    // 仅在macOS且调用ag可执行文件时执行兼容性检查
    if (os.platform() === 'darwin' && isAgCommand) {
        try {
            // 检测可执行文件和系统架构
            const fileOutput = child_process.execSync(`file "${command}"`).toString();
            const currentArch = process.arch;
            const isX86_64Binary = fileOutput.includes('x86_64');

            // 如果是Apple Silicon Mac但二进制是x86_64，则使用arch -x86_64前缀
            if (currentArch === 'arm64' && isX86_64Binary) {
                // 将命令改为使用arch -x86_64运行Intel二进制
                if (debugMode) {
                    outputChannel.log(`[Debug] 检测到Intel二进制文件在Apple Silicon Mac上运行，添加arch -x86_64前缀`);
                }
                originalCommand = command; // 保存原始命令
                originalArgs = [...args];  // 保存原始参数

                // 将命令行参数修改为使用arch命令
                command = 'arch';
                args = ['-x86_64', originalCommand, ...originalArgs];

                if (debugMode) {
                    outputChannel.log(`[Debug] 转换后的命令: ${command} ${args.join(' ')}`);
                }
            }
        } catch (error) {
            // 检测失败时继续使用原始命令
            if (debugMode) {
                outputChannel.warn(`[Debug] macOS架构兼容性检测失败: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    // --- ^ ^ ^ macOS架构兼容处理 ^ ^ ^ ---

    let processInstance: child_process.ChildProcessWithoutNullStreams;
    try {
        // 使用更新后的 spawnOptions
        processInstance = child_process.spawn(command, args, spawnOptions);
    } catch (spawnError) {
        const errorMessage = spawnError instanceof Error ? spawnError.message : 'Unknown spawn error';
        outputChannel.error(`[${commandName}] Failed to spawn process: ${errorMessage}`);
        return {
            success: false,
            message: `[${commandName}] Failed to start: ${errorMessage}`
        };
    }

    let timeoutId: NodeJS.Timeout | null = null;
    const executionPromise = new Promise<number | null>((resolve, reject) => {
        if (config.timeout && commandName !== "运行") {
            timeoutId = setTimeout(() => {
                outputChannel.warn(`[${commandName}] Execution timed out (${config.timeout}ms). Terminating process...`);
                processInstance.kill(); // 使用 processInstance
                reject(new Error(`[${commandName}] Timed out after ${config.timeout}ms`));
            }, config.timeout);
        }

        processInstance.stdout.on('data', (data) => { // 使用 processInstance
            if (!silent) {
                outputChannel.appendRaw(data.toString());
            }
        });

        processInstance.stderr.on('data', (data) => { // 使用 processInstance
            if (!silent) {
                outputChannel.appendRaw(data.toString());
            }
        });

        processInstance.on('close', (code) => { // 使用 processInstance
            if (timeoutId) clearTimeout(timeoutId);
            if (debugMode) {
                outputChannel.log(`[${commandName}] Process exited with code: ${code}`);
            }
            resolve(code);
        });

        processInstance.on('error', (err) => { // 使用 processInstance
            if (timeoutId) clearTimeout(timeoutId);
            outputChannel.warn(`[${commandName}] Process error event: ${err.message}`);
            reject(err);
        });
    });

    try {
        const exitCode = await executionPromise;

        // 简化处理，只记录退出码
        if (debugMode) {
            outputChannel.log(`[Debug] 命令执行完成 - 退出码: ${exitCode}, 命令: ${commandName}`);
        }

        return {
            success: true,
            message: `[${commandName}] 命令执行完成，退出码: ${exitCode}`
        };

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown execution error';
        return {
            success: false,
            message: `[${commandName}] Execution failed: ${errorMessage}`
        };
    }
}

/**
 * 检查并设置文件的执行权限（主要用于macOS）
 * 
 * @param filePath 文件路径
 * @param outputChannel 输出通道（可选）
 * @param debugMode 是否启用调试日志
 * @returns 是否成功设置权限
 */
export function checkAndSetExecutePermission(filePath: string, outputChannel?: OutputChannel, debugMode: boolean = false): boolean {
    // Check if running on macOS
    if (os.platform() !== 'darwin') {
        return true; // No permission check/set needed on non-macOS
    }

    try {
        // Check current permissions
        const stats = fs.statSync(filePath);
        const isExecutable = (stats.mode & fs.constants.S_IXUSR) !== 0;

        if (!isExecutable) {
            if (debugMode && outputChannel) {
                outputChannel.log(`macOS系统：文件缺少执行权限，尝试修复: ${filePath}`);
            }
            // Set execute permission for the user
            fs.chmodSync(filePath, stats.mode | fs.constants.S_IXUSR);
            if (debugMode && outputChannel) {
                outputChannel.success(`已成功设置执行权限: ${filePath}`);
            }
            return true;
        } else {
            if (debugMode && outputChannel) {
                outputChannel.log(`文件已有执行权限: ${filePath}`);
            }
            return true; // Already executable
        }
    } catch (error) {
        if (outputChannel) {
            outputChannel.error(`检查或设置执行权限失败: ${filePath}, 错误: ${error instanceof Error ? error.message : String(error)}`);
        }
        return false; // Indicate failure
    }
}

/**
 * 检测macOS的CPU架构
 * @returns 返回'arm64'或'x86_64'
 */
export function detectMacOSArchitecture(): 'arm64' | 'x86_64' {
    try {
        // 使用process.arch直接获取Node.js进程的架构
        if (process.arch === 'arm64') {
            return 'arm64'; // Apple Silicon (M1/M2/M3...)
        } else {
            return 'x86_64'; // Intel
        }
    } catch (error) {
        // 如果出错，假设是x86_64（更常见的架构）
        return 'x86_64';
    }
}

/**
 * 检查macOS上可执行文件的兼容性，并在日志中提供详细信息和解决方案
 * 
 * @param filePath 可执行文件路径
 * @param outputChannel 输出通道
 * @param debugMode 是否启用调试日志
 * @returns 是否兼容当前架构（如果无法检测则假定为兼容）
 */
export function checkMacOSExecutableCompatibility(filePath: string, outputChannel: OutputChannel, debugMode: boolean = false): boolean {
    if (os.platform() !== 'darwin') {
        return true; // Check is only relevant on macOS
    }

    try {
        const currentArch = detectMacOSArchitecture();
        if (debugMode) {
            outputChannel.log(`检测到当前macOS系统架构: ${currentArch}`);
        }

        // Execute the 'file' command to determine the binary's architecture
        const fileOutput = child_process.execSync(`file "${filePath}"`).toString();
        if (debugMode) {
            outputChannel.log(`文件类型检测: ${fileOutput.trim()}`);
        }

        const isArm64Binary = fileOutput.includes('arm64');
        const isX86_64Binary = fileOutput.includes('x86_64');

        if (currentArch === 'arm64' && !isArm64Binary && isX86_64Binary) {
            // Running on Apple Silicon, but the binary is Intel-only
            // Error logging is handled in the calling function (getAgPath)
            return false;
        } else if (currentArch === 'x86_64' && !isX86_64Binary && isArm64Binary) {
            // Running on Intel, but the binary is Apple Silicon-only
            // Error logging is handled in the calling function (getAgPath)
            return false;
        } else if (!isArm64Binary && !isX86_64Binary) {
            // Could not determine architecture from 'file' output, assume compatible for now
            if (debugMode) {
                outputChannel.warn(`无法从 'file' 命令输出确定 '${filePath}' 的架构。`);
            }
            return true;
        }

        // Compatible or universal binary
        if (debugMode) {
            outputChannel.log(`文件架构与系统兼容: ${filePath}`);
        }
        return true;

    } catch (error) {
        outputChannel.error(`检查macOS可执行文件兼容性失败: ${filePath}, 错误: ${error instanceof Error ? error.message : String(error)}`);
        return true; // Fail safe: If check fails, assume compatible to avoid blocking
    }
} 
