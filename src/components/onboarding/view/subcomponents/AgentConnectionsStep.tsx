import type { LLMProvider } from '../../../../types/app';
import { PROVIDER_IDS, getProviderBrand } from '../../../llm-logo-provider/providerBranding';
import type { ProviderAuthStatusMap } from '../../../provider-auth/types';

import AgentConnectionCard from './AgentConnectionCard';

type AgentConnectionsStepProps = {
  providerStatuses: ProviderAuthStatusMap;
  onOpenProviderLogin: (provider: LLMProvider) => void;
};

export default function AgentConnectionsStep({
  providerStatuses,
  onOpenProviderLogin,
}: AgentConnectionsStepProps) {
  return (
    <div className="space-y-4">
      <div className="text-center">
        <h2 className="font-serif text-xl font-bold tracking-tight text-foreground">Connect Your AI Agents</h2>
        <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-muted-foreground">
          Login to one or more AI coding assistants. All are optional.
        </p>
      </div>

      <div className="-mr-1 max-h-[38vh] space-y-2 overflow-y-auto pr-1">
        {PROVIDER_IDS.map((provider) => {
          const onboarding = getProviderBrand(provider).onboarding;
          return (
            <AgentConnectionCard
              key={provider}
              provider={provider}
              title={onboarding.title}
              status={providerStatuses[provider]}
              connectedClassName={onboarding.connectedClassName}
              iconContainerClassName={onboarding.iconContainerClassName}
              loginButtonClassName={onboarding.loginButtonClassName}
              hideLogin={onboarding.hideLogin}
              onLogin={() => onOpenProviderLogin(provider)}
            />
          );
        })}
      </div>

      <p className="text-center text-xs text-muted-foreground">You can configure these later in Settings.</p>
    </div>
  );
}
