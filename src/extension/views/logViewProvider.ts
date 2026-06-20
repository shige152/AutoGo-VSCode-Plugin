import * as vscode from 'vscode';
import { getUri } from '../../utils/getUri';
import { getNonce } from '../../utils/getNonce';
import { LogWebviewMessageHandler } from '../../services/logWebviewMessageHandler';
import { getOutputChannel, OutputChannel, LogEntry } from '../../services/outputChannel';
import { onDidChangeRunCommandState } from '../../services/runCommandState';
import { LogPanelManager } from './logPanelManager';
import { updateStatusBar } from '../statusbar/logStatusBar'; // Import the status bar updater

export class LogViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'autoGoLogView'; // 必须与 package.json 中的 view id 匹配
    public static currentViewProvider: LogViewProvider | undefined; // Track active instance

    private _view?: vscode.WebviewView;
    private readonly _extensionUri: vscode.Uri;
    private _messageHandler: LogWebviewMessageHandler;
    private _logSubscription?: vscode.Disposable;
    private _runCommandStateSubscription?: vscode.Disposable;
    private _isVisible: boolean = false; // Track visibility

    constructor(private readonly context: vscode.ExtensionContext) {
        this._extensionUri = context.extensionUri;
        this._messageHandler = new LogWebviewMessageHandler(context);
    }

    private debugLog(...args: unknown[]): void {
        if (vscode.workspace.getConfiguration('AutoGo').get<boolean>('debugMode', false)) {
            console.log(...args);
        }
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;
        LogViewProvider.currentViewProvider = this; // Register instance
        this._isVisible = true; // Assume visible initially when resolved

        webviewView.webview.options = {
            // Allow scripts in the webview
            enableScripts: true,
            localResourceRoots: [
                // Allow access to files in the src/webview-ui directory and node_modules
                vscode.Uri.joinPath(this._extensionUri, 'src', 'webview-ui'),
                vscode.Uri.joinPath(this._extensionUri, 'node_modules'),
                vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview-ui')
            ]
        };

        // Set HTML content using the handler
        webviewView.webview.html = this._messageHandler.getHtmlContent(webviewView.webview);

        // Send initial state (including background mode) to the webview
        this._messageHandler.postMessage(webviewView.webview, {
            command: 'setState',
            payload: this._messageHandler.getInitialState()
        });

        // Subscribe to new logs from the OutputChannel first
        const outputChannel = getOutputChannel();

        // Set up message listener using the handler
        webviewView.webview.onDidReceiveMessage(message => {
            // Handle webviewReady message to send initial history
            if (message.command === 'webviewReady') {
                this.debugLog('[LogViewProvider] Webview is ready, sending initial history');
                this.sendFullHistory(outputChannel);
            }
            this._messageHandler.handleMessage(webviewView.webview, message);
        });
        this._logSubscription = outputChannel.onDidLog((logEntry: LogEntry) => {
             if (this._view?.visible && !LogPanelManager.currentPanel) {
                 const showTimestamp = vscode.workspace.getConfiguration('AutoGo').get('showLogTime', true);
                 const htmlContent = OutputChannel.formatLogEntry(logEntry, showTimestamp);
                 this._messageHandler.postMessage(this._view.webview, { command: 'addLog', htmlContent });
             }
        });

        this._runCommandStateSubscription = onDidChangeRunCommandState((running) => {
            this._messageHandler.postMessage(this._view?.webview, {
                command: 'setRunState',
                payload: { running },
            });
        });

        // When the view becomes visible/hidden
        webviewView.onDidChangeVisibility(() => {
             this._isVisible = this._view?.visible ?? false;
             if (this._isVisible) {
                 // View became visible
                 updateStatusBar('View');
                 this.sendFullHistory(outputChannel);
             } else {
                 // View became hidden
                 if (LogPanelManager.currentPanel) {
                     updateStatusBar('Panel');
                 } else {
                     updateStatusBar('None');
                 }
             }
        });

        // Send initial history if already visible when resolved (rare case, but good practice)
        if (this._view.visible) {
            // Also update status bar if initially visible
            updateStatusBar('View');
            this.sendFullHistory(outputChannel);
        }

        // Clean up subscription and static reference on dispose
        webviewView.onDidDispose(() => {
            if (LogViewProvider.currentViewProvider === this) {
                LogViewProvider.currentViewProvider = undefined;
            }
            this._isVisible = false;
            this._logSubscription?.dispose();
            this._logSubscription = undefined;
            this._runCommandStateSubscription?.dispose();
            this._runCommandStateSubscription = undefined;
            this._view = undefined;
        }, null, this.context.subscriptions);

        // Listen for configuration changes to update compile menu
        const configDisposable = vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('AutoGo.targetPlatform')) {
                const targetPlatform = vscode.workspace.getConfiguration('AutoGo').get<'android' | 'ios'>('targetPlatform', 'android');
                this.debugLog('[LogViewProvider] targetPlatform changed to:', targetPlatform);
                this._messageHandler.postMessage(this._view?.webview, {
                    command: 'setCompileMenu',
                    payload: { targetPlatform }
                });
            }
        });
        this.context.subscriptions.push(configDisposable);

        // Inform the webview it's ready (Still useful)
        setTimeout(() => {
             this._messageHandler.postMessage(this._view?.webview, { command: 'webviewIsReady' });
        }, 100);
    }

    /** Sends the full log history to the webview */
    private sendFullHistory(outputChannel: OutputChannel): void {
        if (this._view?.visible) {
             const history = outputChannel.getHistory();
             const showTimestamp = vscode.workspace.getConfiguration('AutoGo').get('showLogTime', true);
             const formattedHistory = history.map((entry: LogEntry) => OutputChannel.formatLogEntry(entry, showTimestamp));
             this._messageHandler.postMessage(this._view.webview, { command: 'restoreLogs', logs: formattedHistory });
        }
    }

    // Method to check if the view associated with this provider is currently visible
    public isViewVisible(): boolean {
        return this._isVisible;
    }

    // Static method to check if *any* LogView provided by this class is visible
    public static isAnyViewVisible(): boolean {
        return !!LogViewProvider.currentViewProvider?._isVisible;
    }
}
