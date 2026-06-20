/**
 * iOS 调试服务
 * 提供 iOS 设备调试的高级功能
 */

import * as fs from 'fs';
import { OutputChannel } from './outputChannel';
import {
  formatDeviceNotConnected,
  formatFileNotFound,
} from '../utils/userMessages';
import {
  iosConnectionManager,
  IosConnectionManager,
} from '../infra/ios/connectionManager';
import { IosDeviceConfig } from '../app/ports/iosDebugClient';
import { DEFAULT_IOS_DEBUG_PORT } from '../infra/ios/protocol/messageTypes';

export class IosDebugService {
  private outputChannel: OutputChannel;
  private connectionManager: IosConnectionManager;

  constructor(outputChannel: OutputChannel) {
    this.outputChannel = outputChannel;
    this.connectionManager = iosConnectionManager;
  }

  /**
   * 连接到 iOS 设备
   * @param host 设备 IP 地址
   * @param port 调试端口（默认 8820）
   */
  async connectDevice(host: string, port: number = DEFAULT_IOS_DEBUG_PORT): Promise<boolean> {
    try {
      const config: IosDeviceConfig = { host, port };
      await this.connectionManager.connect(host, config);

      return true;
    } catch (error: any) {
      this.outputChannel.error(`连接 iOS 设备失败: ${error.message}`);
      return false;
    }
  }

  private forwardDeviceLog(log: string): void {
    this.outputChannel.appendRaw(log);
  }

  /**
   * 断开 iOS 设备连接
   */
  async disconnectDevice(host: string): Promise<void> {
    await this.connectionManager.disconnect(host);
  }

  /**
   * 获取当前连接状态
   */
  isConnected(host: string): boolean {
    return this.connectionManager.isConnected(host);
  }

  /**
   * 推送文件到 iOS 设备
   * @param host 设备 IP
   * @param remotePath 远程路径标识
   * @param localPath 本地文件路径
   */
  async pushFile(
    host: string,
    remotePath: string,
    localPath: string
  ): Promise<boolean> {
    const client = this.connectionManager.getClient(host);
    if (!client) {
      this.outputChannel.error(formatDeviceNotConnected(host));
      return false;
    }

    try {
      if (!fs.existsSync(localPath)) {
        this.outputChannel.error(formatFileNotFound(localPath));
        return false;
      }

      const fileData = fs.readFileSync(localPath);
      const result = await client.pushFile(remotePath, fileData);

      if (result.success) {
        return true;
      } else {
        this.outputChannel.error(`文件推送失败: ${result.error}`);
        return false;
      }
    } catch (error: any) {
      this.outputChannel.error(`推送文件时出错: ${error.message}`);
      return false;
    }
  }

  /**
   * 通知设备文件同步完成
   */
  async syncDone(host: string): Promise<boolean> {
    const client = this.connectionManager.getClient(host);
    if (!client) {
      return false;
    }

    return await client.syncDone();
  }

  /**
   * 在 iOS 设备上运行脚本
   * @param host 设备 IP
   * @param mode 运行模式: 'zip' 或 'bin'
   * @param onLog 日志回调
   * @param onExit 退出回调
   */
  async runScript(
    host: string,
    mode: 'zip' | 'bin',
    onLog?: (log: string) => void,
    onExit?: (exitCode: number) => void
  ): Promise<boolean> {
    const client = this.connectionManager.getClient(host);
    if (!client) {
      this.outputChannel.error(formatDeviceNotConnected(host));
      return false;
    }

    // 先清空之前的处理器，避免重复注册导致日志重复输出
    client.clearLogHandlers();
    client.clearExitHandlers();

    // 注册日志和退出处理器
    if (onLog) {
      client.onLog(onLog);
    }
    if (onExit) {
      client.onExit(onExit);
    }

    try {
      const result = await client.runScript(mode);

      if (result.success) {
        return true;
      } else {
        this.outputChannel.error(`脚本启动失败: ${result.error}`);
        return false;
      }
    } catch (error: any) {
      this.outputChannel.error(`启动脚本时出错: ${error.message}`);
      return false;
    }
  }

  /**
   * 停止 iOS 设备上运行的脚本
   */
  stopScript(host: string): void {
    const client = this.connectionManager.getClient(host);
    if (!client) {
      return;
    }

    client.stopScript();
  }

  /**
   * 执行完整的快速调试流程（eval 模式）
   * @param host 设备 IP
   * @param zipPath ios-debug.zip 文件路径
   */
  async quickDebug(host: string, zipPath: string): Promise<boolean> {
    // 1. 推送 zip 文件
    const pushResult = await this.pushFile(host, 'ios-debug.zip', zipPath);
    if (!pushResult) {
      return false;
    }

    // 2. 启动脚本
    return await this.runScript(
      host,
      'zip',
      (log) => this.forwardDeviceLog(log),
      () => undefined
    );
  }

  /**
   * 执行二进制运行流程
   * @param host 设备 IP
   * @param binaryPath 二进制文件路径
   */
  async runBinary(
    host: string,
    binaryPath: string,
    onExit?: (exitCode: number) => void
  ): Promise<boolean> {
    // 1. 推送二进制文件
    const binaryResult = await this.pushFile(host, 'debug', binaryPath);
    if (!binaryResult) {
      return false;
    }

    // 2. 通知同步完成
    const syncResult = await this.syncDone(host);
    if (!syncResult) {
      this.outputChannel.error('同步完成通知失败');
      return false;
    }

    // 3. 启动二进制
    return await this.runScript(
      host,
      'bin',
      (log) => this.forwardDeviceLog(log),
      onExit ?? (() => undefined)
    );
  }

  /**
   * 断开所有 iOS 设备连接
   */
  async disconnectAll(): Promise<void> {
    await this.connectionManager.disconnectAll();
  }
}
