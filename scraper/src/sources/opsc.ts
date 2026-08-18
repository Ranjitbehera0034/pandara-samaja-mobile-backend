import { discoverNotices } from './common';
import { DiscoveredNotice } from '../types';

const OPSC_URL = 'https://opsc.gov.in';

export function discoverOpsc(isAlreadySeen: (sourceRef: string) => boolean): Promise<DiscoveredNotice[]> {
  return discoverNotices('opsc', OPSC_URL, isAlreadySeen);
}
