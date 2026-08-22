import { discoverByClickToDownload } from './common';
import { DiscoveredNotice } from '../types';

const OPSC_URL = 'https://opsc.gov.in';

export function discoverOpsc(isAlreadySeen: (sourceRef: string) => boolean): Promise<DiscoveredNotice[]> {
  return discoverByClickToDownload(
    {
      sourcePrefix: 'opsc',
      url: OPSC_URL,
      rowSelector: 'li:has(a.button_pdf)',
      titleSelector: '.content_title',
      dateSelector: '.datebox',
      linkSelector: 'a.button_pdf',
      extractId: async (_row, link) => link.getAttribute('id'),
    },
    isAlreadySeen
  );
}
