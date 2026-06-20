import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getNonce } from '../utils/getNonce'; // Utility for nonce
import { getUri } from '../utils/getUri';     // Utility for webview URIs
import { getOutputChannel } from './outputChannel'; // 添加import
import { getRunCommandRunning } from './runCommandState';

// Keep the file path regex here or move to utils
const filePathRegex = /((?:[a-zA-Z]:\\|\/)?(?:[^<>:"\\|?*\n\r]+[\\\/])*)([^<>:"\\|?*\n\r]+\.\w+):(\d+)/g;

/**
 * Manages the HTML content, message passing, and state for the AutoGo log webview.
 * This class can be used by both WebviewPanel and WebviewView providers.
 */
export class LogWebviewMessageHandler implements vscode.Disposable {

    private readonly _extensionUri: vscode.Uri;
    private _webview?: vscode.Webview; // Store webview reference if needed long-term
    private _disposables: vscode.Disposable[] = [];
    private _context: vscode.ExtensionContext; // Store context

    // --- Webview State --- (Can be expanded)
    private _isScrollLocked: boolean = false;
    private _backgroundMode: 'starry' | 'gradient' | 'none'; // Default set in constructor

    // Event emitters for state changes initiated from webview (optional)
    private _onDidReceiveMessage = new vscode.EventEmitter<any>();
    public readonly onDidReceiveMessage = this._onDidReceiveMessage.event;

    constructor(context: vscode.ExtensionContext) {
        this._extensionUri = context.extensionUri;
        this._context = context; // Store context
        // Load initial background mode from global state, default to gradient
        this._backgroundMode = context.globalState.get('autogo.logBackgroundMode', 'gradient');
    }

    private debugLog(...args: unknown[]): void {
        if (vscode.workspace.getConfiguration('AutoGo').get<boolean>('debugMode', false)) {
            console.log(...args);
        }
    }

    private ensureDebCompileOption(htmlContent: string): string {
        if (htmlContent.includes('AutoGo.compileDEB')) {
            return htmlContent;
        }

        const debButtonHtml = [
            '                    <button class="dropdown-item ios-item" data-command="AutoGo.compileDEB">',
            '                        <span class="codicon codicon-package menu-icon" aria-hidden="true"></span>',
            '                        DEB 安装包',
            '                    </button>',
        ].join('\n');

        const compileMenuEndMarker = [
            '                </div>',
            '            </div>',
            '',
            '            <div class="dropdown-container">',
        ].join('\n');

        return htmlContent.replace(compileMenuEndMarker, `${debButtonHtml}\n${compileMenuEndMarker}`);
    }

    /**
     * Generates the HTML content for the webview.
     * @param webview The webview instance.
     * @returns HTML string.
     */
    public getHtmlContent(webview: vscode.Webview): string {
        this.debugLog(`[LogWebviewMessageHandler] GET_HTML_CONTENT_INVOKED - START`);

        const scriptUri = getUri(webview, this._extensionUri, ['dist', 'webview-ui', 'log-webview.js']);
        const styleUri = getUri(webview, this._extensionUri, ['dist', 'webview-ui', 'output', 'output.css']);

        const codiconUri = getUri(webview, this._extensionUri, ['dist', 'webview-ui', 'assets', 'codicon.css']);

        const nonce = getNonce();
        let htmlPageContent = `<html><body>Initial error: Context or path issue. See logs.</body></html>`;
        let absoluteHtmlPath: string = ''; // Declare here to be accessible in catch

        try {
            this.debugLog(`[LogWebviewMessageHandler] TRY_BLOCK_ENTERED`);
            if (!this._context || !this._context.extensionPath) {
                console.error(`[LogWebviewMessageHandler] CRITICAL_ERROR: this._context or this._context.extensionPath is null or undefined.`);
                vscode.window.showErrorMessage('AutoGo Critical Error: Extension context is not available.');
                return htmlPageContent;
            }
            this.debugLog(`[LogWebviewMessageHandler] ExtensionPath reported by context: "${this._context.extensionPath}"`);

            // 使用vscode.Uri.joinPath代替path.join以确保跨平台兼容性
            const targetRelativePath = 'dist/webview-ui/output/output.html';
            const htmlFileUri = vscode.Uri.joinPath(this._extensionUri, targetRelativePath);
            absoluteHtmlPath = htmlFileUri.fsPath; // 使用fsPath获取平台特定的路径

            this.debugLog(`[LogWebviewMessageHandler] Attempting to access HTML file at absolute path: "${absoluteHtmlPath}"`);

            const fileActuallyExists = fs.existsSync(absoluteHtmlPath);
            this.debugLog(`[LogWebviewMessageHandler] fs.existsSync for "${absoluteHtmlPath}" returned: ${fileActuallyExists}`);

            if (fileActuallyExists) {
                this.debugLog(`[LogWebviewMessageHandler] File supposedly exists. Attempting fs.readFileSync...`);
                htmlPageContent = fs.readFileSync(absoluteHtmlPath, 'utf8');
                this.debugLog(`[LogWebviewMessageHandler] fs.readFileSync for output.html was successful.`);

                const imgSrcPolicy = `${webview.cspSource} https: data:`;
                htmlPageContent = htmlPageContent.replace(/\${webview\.cspSource}/g, webview.cspSource);
                htmlPageContent = htmlPageContent.replace(/\${imgSrcPolicy}/g, imgSrcPolicy);
                htmlPageContent = htmlPageContent.replace(/\${nonce}/g, nonce);
                htmlPageContent = htmlPageContent.replace(/\${styleUri}/g, styleUri.toString());
                htmlPageContent = htmlPageContent.replace(/\${codiconUri}/g, codiconUri.toString());
                htmlPageContent = htmlPageContent.replace(/\${scriptUri}/g, scriptUri.toString());
                htmlPageContent = this.ensureDebCompileOption(htmlPageContent);

                this.debugLog(`[LogWebviewMessageHandler] HTML content processed and placeholders replaced.`);

                // 添加调试日志，查看替换后的HTML头部内容
                this.debugLog(`[LogWebviewMessageHandler] HTML head after replacement:`,
                    htmlPageContent.substring(0, htmlPageContent.indexOf('</head>')));
            } else {
                console.error(`[LogWebviewMessageHandler] ERROR: fs.existsSync returned false. The file at "${absoluteHtmlPath}" is reported as NOT FOUND by Node.js.`);
                try {
                    const outputDir = path.dirname(absoluteHtmlPath);
                    this.debugLog(`[LogWebviewMessageHandler] Debug: Checking parent dir of HTML: "${outputDir}". Exists: ${fs.existsSync(outputDir)}`);
                    if(fs.existsSync(outputDir)) {
                        this.debugLog(`[LogWebviewMessageHandler] Debug: Contents of "${outputDir}":`, fs.readdirSync(outputDir));
                    }
                    const webviewUiDir = path.dirname(outputDir);
                    this.debugLog(`[LogWebviewMessageHandler] Debug: Checking grandparent dir: "${webviewUiDir}". Exists: ${fs.existsSync(webviewUiDir)}`);
                    if(fs.existsSync(webviewUiDir)) {
                         this.debugLog(`[LogWebviewMessageHandler] Debug: Contents of "${webviewUiDir}":`, fs.readdirSync(webviewUiDir));
                    }
                } catch (dirError: any) {
                    console.error(`[LogWebviewMessageHandler] Debug: Error during directory listing:`, dirError.message);
                }
                vscode.window.showErrorMessage('无法加载 AutoGo 日志视图内容 (File system check failed).');
                // 提供一个简单的兜底HTML内容，确保至少能显示一些内容
                htmlPageContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AutoGo Output (Fallback)</title>
    <style nonce="${nonce}">
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif; padding: 10px; }
        .error { color: #a00; margin: 20px 0; padding: 10px; background: #fff5f5; border-left: 3px solid #a00; }
    </style>
</head>
<body>
    <h3>AutoGo 日志视图</h3>
    <div class="error">
        <p>无法加载完整的日志视图界面。</p>
        <p>错误位置：${absoluteHtmlPath}</p>
        <p>请检查插件安装是否完整。</p>
    </div>
</body>
</html>`;
            }
            return htmlPageContent;

        } catch (e: any) {
            console.error(`[LogWebviewMessageHandler] UNEXPECTED_ERROR_IN_TRY_BLOCK: ${e.message}`, e.stack);
            // Now absoluteHtmlPath is accessible here if it was assigned in try block
            if (absoluteHtmlPath && e.path === absoluteHtmlPath) {
                 console.error(`[LogWebviewMessageHandler] The error path matches the target HTML path. This was likely the fs.readFileSync failure for output.html.`);
            }
            vscode.window.showErrorMessage('无法加载 AutoGo 日志视图内容 (Unexpected error).');
            return `<html><body>Unexpected error: ${e.message}. Check developer logs for details. Path: ${e.path || 'N/A'}</body></html>`;
        }
    }

    /**
     * Handles messages received from the webview.
     * @param webview The webview that sent the message.
     * @param message The message data.
     */
    public async handleMessage(webview: vscode.Webview, message: any): Promise<void> {
        // Forward the message for external listeners if needed
        this._onDidReceiveMessage.fire(message);

        // Handle specific commands internally
        switch (message.command) {
            case 'webviewReady':
                this.debugLog('[LogWebviewMessageHandler] Webview is ready.');
                // 发送初始状态给 Webview
                this.postMessage(webview, { command: 'setState', payload: this.getInitialState() });
                break;
            case 'openFile':
                await this.handleOpenFileRequest(webview, message.payload.filePath, message.payload.lineNumber, message.payload.linkId);
                break;
            case 'fileSelected':
                await this.handleFileSelected(webview, message.payload.selectedPath, message.payload.lineNumber);
                break;
            case 'clearLogClicked': // Example: If clear button sends a message
                 this.debugLog('[LogWebviewMessageHandler] Clear log clicked in webview.');
                 // 清空OutputChannel的历史记录
                 getOutputChannel().clearHistory();
                 break;
             case 'scrollLockChanged': // Example: If state changes are sent back
                 this._isScrollLocked = message.payload.isLocked;
                 this.debugLog(`[LogWebviewMessageHandler] Scroll lock changed: ${this._isScrollLocked}`);
                 break;
            case 'backgroundModeChanged': // 确认 case 名称匹配前端发送的命令
                 this._backgroundMode = message.payload.mode; // 确认 payload 结构匹配
                 this.debugLog(`[LogWebviewMessageHandler] Background mode changed via webview: ${this._backgroundMode}`);
                 // 保存到 global state
                 this._context.globalState.update('autogo.logBackgroundMode', this._backgroundMode);
                 break;
            case 'toggleLogLocation':
                 this.debugLog('[LogWebviewMessageHandler] Received toggleLogLocation command from webview.');
                 vscode.commands.executeCommand('AutoGo.toggleLogViewLocation');
                 break;

            // Add new cases for the new buttons
            case 'runProject':
                 this.debugLog('[LogWebviewMessageHandler] Received runProject command from webview.');
                 vscode.commands.executeCommand('AutoGo.run'); // Execute the run command
                 break;
            case 'stopProject':
                 this.debugLog('[LogWebviewMessageHandler] Received stopProject command from webview.');
                 vscode.commands.executeCommand('AutoGo.stop'); // Execute the stop command
                 break;
            case 'nodeAid':
                 this.debugLog('[LogWebviewMessageHandler] Received nodeAid command from webview.');
                 vscode.commands.executeCommand('AutoGo.nodeaid'); // Execute the nodeaid command
                 break;

            // Add new cases for the new toolbar buttons
            case 'connectDevice':
                 this.debugLog('[LogWebviewMessageHandler] Received connectDevice command from webview.');
                 vscode.commands.executeCommand('AutoGo.connect'); // Execute the connect command
                 break;
            case 'executeCommand':
                 this.debugLog(`[LogWebviewMessageHandler] Received executeCommand: ${message.payload.command}`);
                 if (message.payload && message.payload.command) {
                      vscode.commands.executeCommand(message.payload.command);
                 }
                 break;
            case 'updateAutoGo':
                 this.debugLog('[LogWebviewMessageHandler] Received updateAutoGo command from webview.');
                 vscode.commands.executeCommand('AutoGo.updateAutoGo'); // Execute updateAutoGo command
                 break;
            case 'quickDebugMainGo':
                 this.debugLog('[LogWebviewMessageHandler] Received quickDebugMainGo command from webview.');
                 vscode.commands.executeCommand('AutoGo.quickDebugMainGo');
                 break;
            case 'updateCompileMenu':
                 this.debugLog('[LogWebviewMessageHandler] Received updateCompileMenu command from webview.');
                 const targetPlatform = vscode.workspace.getConfiguration('AutoGo').get<'android' | 'ios'>('targetPlatform', 'android');
                 this.postMessage(webview, { command: 'setCompileMenu', payload: { targetPlatform } });
                 break;

             // Add other message handlers as needed
        }
    }

     /**
      * Sends a message to the webview.
      * Ensures the webview reference is available.
      * @param webview The target webview.
      * @param message The message to send.
      */
     public postMessage(webview: vscode.Webview | undefined, message: any): void {
         if (webview) {
             webview.postMessage(message);
         } else {
             console.warn('[LogWebviewMessageHandler] Cannot post message, webview reference is missing.');
             // Handle error: Maybe queue message or find the active webview?
         }
     }

    // --- Internal Message Handling Logic (Adapted from OutputChannel) ---

    private async handleOpenFileRequest(webview: vscode.Webview, filePath: string, lineNumber: number, linkId: string) {
        this.debugLog(`[LogWebviewMessageHandler] Received openFile request. Path: '${filePath}', Line: ${lineNumber}, LinkID: ${linkId}`);
        let absolutePath = filePath;
        let isRelativePath = false;
        let workspaceRoot: string | undefined;

        if (!path.isAbsolute(filePath)) {
            isRelativePath = true;
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders && workspaceFolders.length > 0) {
                workspaceRoot = workspaceFolders[0].uri.fsPath;
                absolutePath = path.join(workspaceRoot, filePath);
            } else {
                vscode.window.showErrorMessage(`无法解析相对路径 '${filePath}'，请先打开工作区文件夹。`);
                return;
            }
        }

        if (!fs.existsSync(absolutePath) && isRelativePath) {
            console.warn(`[LogWebviewMessageHandler] Initial path not found: ${absolutePath}. Searching workspace...`);
            try {
                const searchPattern = `**/${filePath}`;
                // Limit search results and exclude node_modules
                const foundFiles = await vscode.workspace.findFiles(searchPattern, '**/node_modules/**', 10);

                if (foundFiles.length === 1) {
                    absolutePath = foundFiles[0].fsPath;
                    this.debugLog(`[LogWebviewMessageHandler] Found unique match via search: ${absolutePath}`);
                    await this.openFileAtLine(absolutePath, lineNumber);
                } else if (foundFiles.length > 1) {
                    this.debugLog(`[LogWebviewMessageHandler] Found multiple matches: ${foundFiles.map(f => f.fsPath).join(', ')}`);
                    const fileOptions = foundFiles.map(fileUri => ({
                        label: workspaceRoot ? path.relative(workspaceRoot, fileUri.fsPath) : fileUri.fsPath,
                        description: workspaceRoot ? fileUri.fsPath : '',
                        fullPath: fileUri.fsPath
                    }));
                    // Send message back to webview to show the popup
                    this.postMessage(webview, {
                        command: 'requestFileSelection',
                        payload: {
                            fileOptions: fileOptions,
                            lineNumber: lineNumber,
                            linkId: linkId
                        }
                    });
                } else {
                    vscode.window.showErrorMessage(`在工作区中找不到文件: ${filePath}`);
                }
            } catch (searchError) {
                vscode.window.showErrorMessage(`搜索文件 '${filePath}' 时出错。`);
                console.error(`[LogWebviewMessageHandler] File search error:`, searchError);
            }
        } else if (fs.existsSync(absolutePath)) {
            this.debugLog(`[LogWebviewMessageHandler] Path exists directly: ${absolutePath}. Opening...`);
            await this.openFileAtLine(absolutePath, lineNumber);
        } else {
            vscode.window.showErrorMessage(`文件不存在: ${absolutePath}`);
        }
    }

    private async handleFileSelected(webview: vscode.Webview, selectedPath: string, lineNumber: number) {
        this.debugLog(`[LogWebviewMessageHandler] Received fileSelected message. Path: '${selectedPath}', Line: ${lineNumber}`);
        if (fs.existsSync(selectedPath)) {
            await this.openFileAtLine(selectedPath, lineNumber);
        } else {
            vscode.window.showErrorMessage(`选择的文件不存在或无法访问: ${selectedPath}`);
            console.warn(`[LogWebviewMessageHandler] Selected file path does not exist: ${selectedPath}`);
        }
    }

    private async openFileAtLine(absolutePath: string, lineNumber: number) {
        try {
            this.debugLog(`[LogWebviewMessageHandler] Opening file: ${absolutePath} at line ${lineNumber}`);
            const uri = vscode.Uri.file(absolutePath);
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, {
                viewColumn: vscode.ViewColumn.One, // Open in the first column
                selection: new vscode.Range(new vscode.Position(lineNumber - 1, 0), new vscode.Position(lineNumber - 1, 0)) // 0-based line
            });
            this.debugLog(`[LogWebviewMessageHandler] Successfully opened ${absolutePath}`);
        } catch (err) {
            vscode.window.showErrorMessage(`无法打开文件 ${absolutePath}: ${err}`);
            console.error(`[LogWebviewMessageHandler] Error opening document ${absolutePath}:`, err);
        }
    }

    /** Gets the initial state to send to the webview */
    public getInitialState(): { backgroundMode: string; targetPlatform: 'android' | 'ios'; runCommandRunning: boolean } {
        // 读取最新的状态，而不是构造函数里的初始值
        const currentMode = this._context.globalState.get('autogo.logBackgroundMode', 'gradient');
        this._backgroundMode = currentMode; // 更新内部状态以防万一
        // 读取 targetPlatform 配置
        const targetPlatform = vscode.workspace.getConfiguration('AutoGo').get<'android' | 'ios'>('targetPlatform', 'android');
        return { backgroundMode: currentMode, targetPlatform, runCommandRunning: getRunCommandRunning() };
    }

    public dispose(): void {
        this._onDidReceiveMessage.dispose();
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];
    }
}
