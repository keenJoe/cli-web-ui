import type { LLMProvider } from '../../types/app';

import { getProviderBrand } from './providerBranding';

type SessionProviderLogoProps = {
  provider?: LLMProvider | string | null;
  className?: string;
};

export default function SessionProviderLogo({
  provider = 'claude',
  className = 'w-5 h-5',
}: SessionProviderLogoProps) {
  const Logo = getProviderBrand(provider).Logo;
  return <Logo className={className} />;
}
