import * as vscode from 'vscode';

let runCommandRunning = false;

const onDidChangeRunCommandStateEmitter = new vscode.EventEmitter<boolean>();

export const onDidChangeRunCommandState = onDidChangeRunCommandStateEmitter.event;

export function getRunCommandRunning(): boolean {
    return runCommandRunning;
}

export function setRunCommandRunning(running: boolean): void {
    if (runCommandRunning === running) {
        return;
    }

    runCommandRunning = running;
    onDidChangeRunCommandStateEmitter.fire(running);
}
