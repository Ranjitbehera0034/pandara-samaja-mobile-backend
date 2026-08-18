import { discoverNotices } from './common';
import { DiscoveredNotice } from '../types';

const OSSC_URL = 'https://ossc.gov.in';

export function discoverOssc(isAlreadySeen: (sourceRef: string) => boolean): Promise<DiscoveredNotice[]> {
  return discoverNotices('ossc', OSSC_URL, isAlreadySeen);
}
