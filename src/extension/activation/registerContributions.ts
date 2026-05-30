import * as vscode from 'vscode';
import { ArtifactStore } from '../../app/services/artifactStore';
import { OutputChannel } from '../../services/outputChannel';
import { AdbService } from '../../services/adbService';
import { ConfigService } from '../../services/configService';
import { IosDebugService } from '../../services/iosDebugService';
import { NdkDownloadDeps } from '../../services/environmentSetupService';
import { registerDeviceCommands } from '../commands/device/deviceContribution';
import { registerLogsContribution } from '../commands/logs/logsContribution';
import { registerRunCommands } from '../commands/run/runContribution';
import { registerSetupCommands } from '../commands/setup/setupContribution';
import { registerSyncCommands } from '../commands/sync/syncContribution';

import { initializeLogStatusBar } from '../statusbar/logStatusBar';

type LogViewPreference = 'Panel' | 'View' | 'None';

export interface ContributionDeps {
  context: vscode.ExtensionContext;
  outputChannel: OutputChannel;
  configService: ConfigService;
  artifactStore: ArtifactStore;
  adbService: AdbService;
  iosDebugService: IosDebugService;
  ndkDeps: NdkDownloadDeps;
  getAgPath: () => string | null;
  refreshAgPath: () => Promise<string | null>;
  getLogViewPreference: () => LogViewPreference;
  setLogViewPreference: (preference: LogViewPreference) => void;
}

export function registerContributions(deps: ContributionDeps): vscode.Disposable[] {
  const {
    context,
    outputChannel,
    configService,
    artifactStore,
    adbService,
    iosDebugService,
    ndkDeps,
    getAgPath,
    refreshAgPath,
    getLogViewPreference,
    setLogViewPreference,
  } = deps;

  const disposables: vscode.Disposable[] = [];

  initializeLogStatusBar(context);

  disposables.push(
    ...registerSetupCommands({
      context,
      outputChannel,
      configService,
      adbService,
      artifactStore,
      getAgPath,
      refreshAgPath,
      getLogViewPreference,
    }),
  );

  disposables.push(
    ...registerSyncCommands({
      context,
      outputChannel,
      configService,
      getAgPath,
      getLogViewPreference,
    }),
  );

  disposables.push(
    ...registerRunCommands({
      context,
      outputChannel,
      configService,
      ndkDeps,
      adbService,
      iosDebugService,
      getAgPath,
      getLogViewPreference,
    }),
  );

  disposables.push(
    ...registerDeviceCommands({
      context,
      outputChannel,
      configService,
      adbService,
      iosDebugService,
      resolveAgPath: refreshAgPath,
      getLogViewPreference,
    }),
  );

  disposables.push(
    ...registerLogsContribution({
      context,
      setPreference: setLogViewPreference,
    }),
  );

  return disposables;
}
