import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import { cloneElement, createContext, isValidElement, use, type ReactNode } from 'react';
import { ActionSheetIOS, Alert, Platform, type TextProps, type TextStyle } from 'react-native';
import { Renderer } from 'react-native-marked';

import type { RunpanePanelOpenRequest, RunpanePanelOpenResult } from '@shared/types/runpaneOrchestration';

import { useInvokeMutation } from '@/daemon';

import { LINK_ACTION_LABELS, linkActions, type LinkAction } from './linkActions';

/** The Pane whose tabs are on screen: Open in Pane opens a link there. */
export const LinkPane = createContext<string | undefined>(undefined);

/** Markdown links that open in the phone's browser on a tap and offer the link menu on a long press. */
class LinkMenuRenderer extends Renderer {
  constructor(private readonly onLongPress: (url: string) => void) {
    super();
  }

  override link(children: string | ReactNode[], href: string, styles?: TextStyle, title?: string): ReactNode {
    const node = super.link(children, href, styles, title);
    // Not selectable, so the long press reaches the menu instead of starting a text selection.
    return isValidElement<TextProps>(node) ? cloneElement(node, { selectable: false, accessibilityHint: 'Long press for more options', onLongPress: () => this.onLongPress(href) }) : node;
  }
}

/**
 * A `useMarkdown` renderer whose links offer Open in Pane, Open in browser and Copy link on a
 * long press, as the desktop's link popover does. Open in Pane opens the link as a browser tab
 * beside the person's tab; the phone follows the host to it.
 */
export function useLinkRenderer(): Renderer {
  const paneId = use(LinkPane);
  const open = useInvokeMutation<[RunpanePanelOpenRequest], RunpanePanelOpenResult>('runpane:panels:open', { invalidates: ['panels:list'] });
  const run = (action: LinkAction, url: string) => {
    if (action === 'pane' && paneId) {
      open.mutate([{ paneId, url, placement: 'split', source: 'user' }], { onError: error => Alert.alert('Couldn’t open the link in Pane', error.message) });
    } else if (action === 'browser') {
      Linking.openURL(url).catch(() => Alert.alert('Couldn’t open the link', url));
    } else if (action === 'copy') {
      void Clipboard.setStringAsync(url);
    }
  };
  const showMenu = (url: string) => {
    const actions = linkActions(url, paneId);
    const labels = actions.map(action => LINK_ACTION_LABELS[action]);
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions({ title: url, options: [...labels, 'Cancel'], cancelButtonIndex: labels.length }, index => {
        if (index < actions.length) run(actions[index], url);
      });
    } else {
      // Android shows three buttons at most, so the menu dismisses with Back or a tap outside.
      Alert.alert(url, undefined, actions.map(action => ({ text: LINK_ACTION_LABELS[action], onPress: () => run(action, url) })), { cancelable: true });
    }
  };
  return new LinkMenuRenderer(showMenu);
}
