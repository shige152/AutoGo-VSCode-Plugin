import * as vscode from 'vscode';
import { LogWebviewMessageHandler } from '../../services/logWebviewMessageHandler';
import { getOutputChannel, OutputChannel, LogEntry } from '../../services/outputChannel';
import { onDidChangeRunCommandState } from '../../services/runCommandState';
import { updateStatusBar } from '../statusbar/logStatusBar';
import { LogViewProvider } from './logViewProvider';

/**
 * Manages the AutoGo Log Webview Panel displayed in the editor area.
 * Ensures only one instance of the panel exists.
 */
export class LogPanelManager {
    public static currentPanel: LogPanelManager | undefined;
    public static readonly viewType = 'autoGoLogPanel'; // Distinct view type for the panel

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _messageHandler: LogWebviewMessageHandler;
    private _logSubscription?: vscode.Disposable;
    private _runCommandStateSubscription?: vscode.Disposable;

    private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
        this._panel = panel;
        this._extensionUri = context.extensionUri;
        this._messageHandler = new LogWebviewMessageHandler(context);

        // Set the webview's initial html content
        this._panel.webview.html = this._messageHandler.getHtmlContent(this._panel.webview);

        // Send initial state (including background mode) to the webview
        // Do this soon after setting HTML, before the webview fully initializes its JS if possible
        this._messageHandler.postMessage(this._panel.webview, {
            command: 'setState',
            payload: this._messageHandler.getInitialState()
        });

        // Listen for when the panel is disposed
        // This happens when the user closes the panel or when the panel is closed programmatically
        this._panel.onDidDispose(() => {
            this.dispose();
            // Update status bar AFTER disposal
            if (LogViewProvider.isAnyViewVisible()) {
                updateStatusBar('View');
            } else {
                updateStatusBar('None');
            }
        }, null, this._disposables);

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            message => {
                this._messageHandler.handleMessage(this._panel.webview, message);
            },
            null,
            this._disposables
        );

        // Subscribe to new logs from the OutputChannel
        const outputChannel = getOutputChannel();
        this._logSubscription = outputChannel.onDidLog((logEntry: LogEntry) => {
            // Panel might not be visible, but we still send logs if it exists
            const showTimestamp = vscode.workspace.getConfiguration('AutoGo').get('showLogTime', true);
            const htmlContent = OutputChannel.formatLogEntry(logEntry, showTimestamp);
            this._messageHandler.postMessage(this._panel.webview, { command: 'addLog', htmlContent });
        });
        this._disposables.push(this._logSubscription);

        this._runCommandStateSubscription = onDidChangeRunCommandState((running) => {
            this._messageHandler.postMessage(this._panel.webview, {
                command: 'setRunState',
                payload: { running },
            });
        });
        this._disposables.push(this._runCommandStateSubscription);

        // Send full history initially
        this.sendFullHistory(outputChannel);

        // Inform the webview it's ready
        setTimeout(() => {
             this._messageHandler.postMessage(this._panel.webview, { command: 'webviewIsReady' });
        }, 100);
    }

    /** Sends the full log history to the webview */
    private sendFullHistory(outputChannel: OutputChannel): void {
        const history = outputChannel.getHistory();
        const showTimestamp = vscode.workspace.getConfiguration('AutoGo').get('showLogTime', true);
        const formattedHistory = history.map((entry: LogEntry) => OutputChannel.formatLogEntry(entry, showTimestamp));
        this._messageHandler.postMessage(this._panel.webview, { command: 'restoreLogs', logs: formattedHistory });
    }

    public dispose() {
        LogPanelManager.currentPanel = undefined;

        // Clean up our resources
        this._panel.dispose();
        this._logSubscription?.dispose();
        this._runCommandStateSubscription?.dispose();
        this._messageHandler.dispose(); // Dispose the handler too

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    /**
     * Creates or reveals the AutoGo Log Panel.
     * @param context The extension context.
     */
    public static render(context: vscode.ExtensionContext) {
        // const column = vscode.window.activeTextEditor // We don't need the active column anymore
        //     ? vscode.window.activeTextEditor.viewColumn
        //     : undefined;

        // If we already have a panel, show it beside the active group.
        if (LogPanelManager.currentPanel) {
            LogPanelManager.currentPanel._panel.reveal(vscode.ViewColumn.Beside); // <<< CHANGED: Reveal beside
            return;
        }

        // Otherwise, create a new panel beside the active group.
        const panel = vscode.window.createWebviewPanel(
            LogPanelManager.viewType,
            'AutoGo 日志 (Panel)', // Title in the editor tab
            vscode.ViewColumn.Beside, // <<< CHANGED: Always create beside
            {
                enableScripts: true,
                retainContextWhenHidden: true, // Keep state even when not visible
                localResourceRoots: [
                    vscode.Uri.joinPath(context.extensionUri, 'src', 'webview-ui'),
                    vscode.Uri.joinPath(context.extensionUri, 'node_modules'),
                    vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui')
                ]
            }
        );

        LogPanelManager.currentPanel = new LogPanelManager(panel, context);
        updateStatusBar('Panel'); // Update status bar when panel is successfully created
    }
}
