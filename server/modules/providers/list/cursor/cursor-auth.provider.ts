import spawn from 'cross-spawn';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { runCliVersionProbe } from '@/shared/utils.js';

type CursorLoginStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

type CursorStatusCommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

type CursorAuthDependencies = {
  checkInstalled(): boolean;
  readLoginStatus(): Promise<CursorStatusCommandResult>;
};

function checkCursorInstalled(): boolean {
  return runCliVersionProbe('cursor-agent', ['--version']);
}

function readCursorLoginStatus(): Promise<CursorStatusCommandResult> {
  return new Promise((resolve) => {
    let processCompleted = false;
    let childProcess: ReturnType<typeof spawn> | undefined;

    const finish = (result: CursorStatusCommandResult): void => {
      if (processCompleted) {
        return;
      }
      processCompleted = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      childProcess?.kill();
      finish({
        code: null,
        stdout: '',
        stderr: '',
        error: 'Command timeout',
      });
    }, 5000);

    try {
      childProcess = spawn('cursor-agent', ['status']);
    } catch {
      finish({
        code: null,
        stdout: '',
        stderr: '',
        error: 'Cursor CLI not found or not installed',
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    childProcess.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    childProcess.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    childProcess.on('close', (code) => {
      finish({ code, stdout, stderr });
    });
    childProcess.on('error', () => {
      finish({
        code: null,
        stdout,
        stderr,
        error: 'Cursor CLI not found or not installed',
      });
    });
  });
}

const defaultDependencies: CursorAuthDependencies = {
  checkInstalled: checkCursorInstalled,
  readLoginStatus: readCursorLoginStatus,
};

/** Provider registry auth facet used to report Cursor CLI readiness. */
export class CursorProviderAuth implements IProviderAuth {
  private readonly dependencies: CursorAuthDependencies;

  constructor(dependencies: Partial<CursorAuthDependencies> = {}) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  /**
   * Checks whether the cursor-agent CLI is available on this host.
   */
  private checkInstalled(): boolean {
    return this.dependencies.checkInstalled();
  }

  /**
   * Returns Cursor CLI installation and login status.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();

    if (!installed) {
      return {
        installed,
        provider: 'cursor',
        authenticated: false,
        email: null,
        method: null,
        error: 'Cursor CLI is not installed',
      };
    }

    const login = await this.checkCursorLogin();

    return {
      installed,
      provider: 'cursor',
      authenticated: login.authenticated,
      email: login.email,
      method: login.method,
      error: login.authenticated ? undefined : login.error || 'Not logged in',
    };
  }

  /**
   * Runs cursor-agent status and parses the login marker from stdout.
   */
  private async checkCursorLogin(): Promise<CursorLoginStatus> {
    const result = await this.dependencies.readLoginStatus();
    if (result.error) {
      return {
        authenticated: false,
        email: null,
        method: null,
        error: result.error,
      };
    }

    if (result.code !== 0) {
      return {
        authenticated: false,
        email: null,
        method: null,
        error: result.stderr || 'Not logged in',
      };
    }

    if (/unable to fetch user details/i.test(result.stdout)) {
      return {
        authenticated: false,
        email: null,
        method: null,
        error: 'Unable to verify Cursor account details',
      };
    }

    const emailMatch = result.stdout.match(
      /Logged in as ([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i,
    );
    if (emailMatch?.[1]) {
      return { authenticated: true, email: emailMatch[1], method: 'cli' };
    }

    if (result.stdout.includes('Logged in')) {
      return { authenticated: true, email: 'Logged in', method: 'cli' };
    }

    return {
      authenticated: false,
      email: null,
      method: null,
      error: 'Not logged in',
    };
  }
}
