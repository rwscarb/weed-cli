"""weed for Kodi -- the entry point Kodi calls.

All the thinking is in resources/lib/plugin.py; this file only parses
the plugin:// URL Kodi invoked us with and wraps the xbmc* modules in
the small ui object plugin.py expects.
"""
import os
import sys
import urllib.parse

import xbmc
import xbmcaddon
import xbmcgui
import xbmcplugin

ADDON = xbmcaddon.Addon()
sys.path.insert(0, os.path.join(ADDON.getAddonInfo('path'), 'resources', 'lib'))

from resources.lib.plugin import Plugin   # noqa: E402

HANDLE = int(sys.argv[1])
BASE_URL = sys.argv[0]


def build_url(action, **params):
    q = {'action': action}
    q.update({k: v for k, v in params.items() if v is not None})
    return BASE_URL + '?' + urllib.parse.urlencode(q)


class KodiUI:
    def settings(self):
        return {'server': ADDON.getSetting('server'), 'token': ADDON.getSetting('token')}

    def folder(self, label, action, **params):
        item = xbmcgui.ListItem(label=label)
        xbmcplugin.addDirectoryItem(HANDLE, build_url(action, **params), item, isFolder=True)

    def media(self, label, url, info, action, **params):
        item = xbmcgui.ListItem(label=label)
        item.setInfo('video', {k: v for k, v in info.items() if k in ('title', 'playcount', 'size', 'mediatype')})
        item.setProperty('IsPlayable', 'true')
        # select -> our own 'play' action, so the node counts the play;
        # it resolves to the stream URL through setResolvedUrl below
        xbmcplugin.addDirectoryItem(HANDLE, build_url(action, **params), item, isFolder=False)

    def end(self, content=None):
        if content:
            xbmcplugin.setContent(HANDLE, content)
        xbmcplugin.endOfDirectory(HANDLE)

    def play(self, url, label, info):
        item = xbmcgui.ListItem(label=label, path=url)
        item.setInfo('video', {'title': info.get('title', label)})
        # invoked as a playable item's resolver when Kodi called us for
        # it, otherwise (Autopilot, the live feeds) start playback directly
        if HANDLE >= 0 and 'action=play' in ' '.join(sys.argv):
            xbmcplugin.setResolvedUrl(HANDLE, True, item)
        else:
            xbmc.Player().play(url, item)

    def play_all(self, entries):
        pl = xbmc.PlayList(xbmc.PLAYLIST_VIDEO)
        pl.clear()
        for url, label, info in entries:
            item = xbmcgui.ListItem(label=label, path=url)
            item.setInfo('video', {'title': info.get('title', label)})
            pl.add(url, item)
        xbmc.Player().play(pl)

    def notify(self, message):
        xbmcgui.Dialog().notification('weed', message, xbmcgui.NOTIFICATION_INFO, 3000)
        xbmc.log('[weed] ' + message, xbmc.LOGINFO)


def main():
    params = dict(urllib.parse.parse_qsl(sys.argv[2][1:] if len(sys.argv) > 2 else ''))
    Plugin(KodiUI()).run(**params)


if __name__ == '__main__':
    main()
