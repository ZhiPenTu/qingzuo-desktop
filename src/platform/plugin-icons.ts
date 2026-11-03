import aiChatIcon from '@/assets/ai-chat.svg';
import aiImageIcon from '@/assets/plugin-icons/official.ai-image.svg';
import labelEditIcon from '@/assets/plugin-icons/official.labeledit.svg';
import removeBgIcon from '@/assets/plugin-icons/official.removebg.svg';
import seedAudioIcon from '@/assets/plugin-icons/official.seed-audio.svg';
import seedanceIcon from '@/assets/plugin-icons/official.seedance.svg';
import seedreamIcon from '@/assets/plugin-icons/official.seedream.svg';
import sheinFullIcon from '@/assets/plugin-icons/official.shein-full.svg';
import videoDownloaderIcon from '@/assets/plugin-icons/official.video-downloader.svg';

export { aiChatIcon };

type PluginTier = 'platform' | 'official' | 'community';

const officialPluginIcons: Record<string, string> = {
  'official.ai-image': aiImageIcon,
  'official.labeledit': labelEditIcon,
  'official.removebg': removeBgIcon,
  'official.seed-audio': seedAudioIcon,
  'official.seedance': seedanceIcon,
  'official.seedream': seedreamIcon,
  'official.shein-full': sheinFullIcon,
  'official.video-downloader': videoDownloaderIcon,
};

export function resolvePluginIcon(id: string, icon?: string | null, trust?: boolean | { tier?: PluginTier; source?: string }): string | undefined {
  if (icon) return icon;
  if (typeof trust === 'boolean') return trust ? officialPluginIcons[id] : undefined;
  const trustedTier = trust?.tier === 'platform' || trust?.tier === 'official';
  const trustedSource = trust?.source === 'market' || trust?.source === 'bundled';
  return trustedTier && trustedSource ? officialPluginIcons[id] : undefined;
}
