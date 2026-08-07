import type { ComponentType } from 'react';

import { IS_PLATFORM } from '../../constants/config';

import ClaudeLogo from './ClaudeLogo';
import CodexLogo from './CodexLogo';
import CursorLogo from './CursorLogo';
import OpenCodeLogo from './OpenCodeLogo';
import PiLogo from './PiLogo';

type ProviderBrand = {
  displayName: string;
  companyName: string;
  description: string;
  readyPrompt: {
    key: string;
    defaultValue?: string;
  };
  messageLabel: {
    key: string;
    defaultValue?: string;
  };
  login: {
    title: string;
    command: string;
  };
  onboarding: {
    title: string;
    connectedClassName: string;
    iconContainerClassName: string;
    loginButtonClassName: string;
    hideLogin: boolean;
  };
  skillsLabel: string;
  skillPath?: string;
  Logo: ComponentType<{ className?: string }>;
  dotClass: string;
  accountClasses: {
    background: string;
    border: string;
    text: string;
    subtext: string;
    button: string;
  };
};

export const PROVIDER_BRANDS = {
  claude: {
    displayName: 'Claude',
    companyName: 'Anthropic',
    description: 'Claude CLI assistant',
    readyPrompt: { key: 'providerSelection.readyPrompt.claude' },
    messageLabel: { key: 'messageTypes.claude' },
    login: {
      title: 'Claude CLI Login',
      command: 'claude --dangerously-skip-permissions /login',
    },
    onboarding: {
      title: 'Claude Code',
      connectedClassName: 'border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-900/20',
      iconContainerClassName: 'bg-blue-100 dark:bg-blue-900/30',
      loginButtonClassName: 'bg-blue-600 hover:bg-blue-700',
      hideLogin: false,
    },
    skillsLabel: 'Skills',
    skillPath: '~/.claude/skills/<skill-name>/SKILL.md',
    Logo: ClaudeLogo,
    dotClass: 'bg-blue-500',
    accountClasses: {
      background: 'bg-blue-50 dark:bg-blue-900/20',
      border: 'border-blue-200 dark:border-blue-800',
      text: 'text-blue-900 dark:text-blue-100',
      subtext: 'text-blue-700 dark:text-blue-300',
      button: 'bg-blue-600 hover:bg-blue-700 active:bg-blue-800',
    },
  },
  cursor: {
    displayName: 'Cursor',
    companyName: 'Cursor',
    description: 'Cursor CLI assistant',
    readyPrompt: { key: 'providerSelection.readyPrompt.cursor' },
    messageLabel: { key: 'messageTypes.cursor' },
    login: {
      title: 'Cursor CLI Login',
      command: 'cursor-agent login',
    },
    onboarding: {
      title: 'Cursor',
      connectedClassName: 'border-purple-200 bg-purple-50 dark:border-purple-800 dark:bg-purple-900/20',
      iconContainerClassName: 'bg-purple-100 dark:bg-purple-900/30',
      loginButtonClassName: 'bg-purple-600 hover:bg-purple-700',
      hideLogin: false,
    },
    skillsLabel: 'Skills',
    skillPath: '~/.cursor/skills/<skill-name>/SKILL.md',
    Logo: CursorLogo,
    dotClass: 'bg-purple-500',
    accountClasses: {
      background: 'bg-purple-50 dark:bg-purple-900/20',
      border: 'border-purple-200 dark:border-purple-800',
      text: 'text-purple-900 dark:text-purple-100',
      subtext: 'text-purple-700 dark:text-purple-300',
      button: 'bg-purple-600 hover:bg-purple-700 active:bg-purple-800',
    },
  },
  codex: {
    displayName: 'Codex',
    companyName: 'OpenAI',
    description: 'Codex CLI assistant',
    readyPrompt: { key: 'providerSelection.readyPrompt.codex' },
    messageLabel: { key: 'messageTypes.codex' },
    login: {
      title: 'Codex CLI Login',
      command: IS_PLATFORM ? 'codex login --device-auth' : 'codex login',
    },
    onboarding: {
      title: 'OpenAI Codex',
      connectedClassName: 'border-gray-300 bg-gray-100 dark:border-gray-600 dark:bg-gray-800/50',
      iconContainerClassName: 'bg-gray-100 dark:bg-gray-800',
      loginButtonClassName: 'bg-gray-800 hover:bg-gray-900 dark:bg-gray-700 dark:hover:bg-gray-600',
      hideLogin: false,
    },
    skillsLabel: 'Skills',
    skillPath: '~/.agents/skills/<skill-name>/SKILL.md',
    Logo: CodexLogo,
    dotClass: 'bg-foreground/60',
    accountClasses: {
      background: 'bg-muted/50',
      border: 'border-gray-300 dark:border-gray-600',
      text: 'text-gray-900 dark:text-gray-100',
      subtext: 'text-gray-700 dark:text-gray-300',
      button: 'bg-gray-800 hover:bg-gray-900 active:bg-gray-950 dark:bg-gray-700 dark:hover:bg-gray-600 dark:active:bg-gray-500',
    },
  },
  opencode: {
    displayName: 'OpenCode',
    companyName: 'OpenCode',
    description: 'OpenCode CLI assistant',
    readyPrompt: {
      key: 'providerSelection.readyPrompt.opencode',
      defaultValue: 'Ready with OpenCode {{model}}',
    },
    messageLabel: {
      key: 'messageTypes.opencode',
      defaultValue: 'OpenCode',
    },
    login: {
      title: 'OpenCode CLI Login',
      command: 'opencode auth login',
    },
    onboarding: {
      title: 'OpenCode',
      connectedClassName: 'border-zinc-300 bg-zinc-100 dark:border-zinc-600 dark:bg-zinc-800/50',
      iconContainerClassName: 'bg-zinc-100 dark:bg-zinc-800',
      loginButtonClassName: 'bg-zinc-800 hover:bg-zinc-900 dark:bg-zinc-700 dark:hover:bg-zinc-600',
      hideLogin: false,
    },
    skillsLabel: 'Shared Skills',
    Logo: OpenCodeLogo,
    dotClass: 'bg-zinc-500',
    accountClasses: {
      background: 'bg-zinc-50 dark:bg-zinc-900/20',
      border: 'border-zinc-200 dark:border-zinc-700',
      text: 'text-zinc-900 dark:text-zinc-100',
      subtext: 'text-zinc-700 dark:text-zinc-300',
      button: 'bg-zinc-900 hover:bg-zinc-800 active:bg-zinc-950 dark:bg-zinc-700 dark:hover:bg-zinc-600',
    },
  },
  pi: {
    displayName: 'Pi',
    companyName: 'Pi',
    description: 'Pi CLI assistant',
    readyPrompt: {
      key: 'providerSelection.readyPrompt.pi',
      defaultValue: 'Ready with Pi {{model}}',
    },
    messageLabel: {
      key: 'messageTypes.pi',
      defaultValue: 'Pi',
    },
    login: {
      title: 'Pi CLI',
      command: 'pi',
    },
    onboarding: {
      title: 'Pi',
      connectedClassName: 'border-zinc-300 bg-zinc-100 dark:border-zinc-600 dark:bg-zinc-800/50',
      iconContainerClassName: 'bg-zinc-100 dark:bg-zinc-800',
      loginButtonClassName: 'bg-zinc-800 hover:bg-zinc-900 dark:bg-zinc-700 dark:hover:bg-zinc-600',
      hideLogin: true,
    },
    skillsLabel: 'Skills',
    Logo: PiLogo,
    dotClass: 'bg-zinc-500',
    accountClasses: {
      background: 'bg-zinc-50 dark:bg-zinc-900/20',
      border: 'border-zinc-200 dark:border-zinc-700',
      text: 'text-zinc-900 dark:text-zinc-100',
      subtext: 'text-zinc-700 dark:text-zinc-300',
      button: 'bg-zinc-900 hover:bg-zinc-800 active:bg-zinc-950 dark:bg-zinc-700 dark:hover:bg-zinc-600',
    },
  },
} satisfies Record<string, ProviderBrand>;

export type LLMProvider = keyof typeof PROVIDER_BRANDS;

export const PROVIDER_IDS = Object.keys(PROVIDER_BRANDS) as LLMProvider[];

export function getProviderDisplayName(provider: string): string {
  return provider in PROVIDER_BRANDS
    ? PROVIDER_BRANDS[provider as LLMProvider].displayName
    : provider;
}

export function getProviderBrand(provider: LLMProvider | string | null | undefined): ProviderBrand {
  return provider && provider in PROVIDER_BRANDS
    ? PROVIDER_BRANDS[provider as LLMProvider]
    : PROVIDER_BRANDS.claude;
}
