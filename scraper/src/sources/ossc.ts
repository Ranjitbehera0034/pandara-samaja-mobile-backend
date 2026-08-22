import { discoverByClickToDownload } from './common';
import { DiscoveredNotice } from '../types';

const OSSC_URL = 'https://ossc.gov.in';

export function discoverOssc(isAlreadySeen: (sourceRef: string) => boolean): Promise<DiscoveredNotice[]> {
  return discoverByClickToDownload(
    {
      sourcePrefix: 'ossc',
      url: OSSC_URL,
      rowSelector: 'li:has(a.button_pdf)',
      titleSelector: '.content_title',
      dateSelector: '.datebox',
      linkSelector: 'a.button_pdf',
      extractId: async (_row, link) => link.getAttribute('id'),
    },
    isAlreadySeen
  );
}
