# Age rating answers

**Expected rating: 4+.** Paseo, the closest comparable listing (a phone remote for coding agents), is rated 4+.

Pane shows the text output of command-line tools and AI coding agents that the user runs on their own computer. It has no content of its own, no users other than the owner, and no web browser. The answers below follow the App Store Connect age rating questionnaire, section by section. Each answer comes from `compliance.md` §2 and the app source on `rn-pane-expo-app` at `c391631c`.

## In-app controls

| Question | Answer | Reason |
| --- | --- | --- |
| Parental controls | No | The app has no content settings to control. |
| Age assurance | No | The app has no accounts and no age-gated content. |

## Capabilities

| Question | Answer | Reason |
| --- | --- | --- |
| Unrestricted web access | No | The only WebView is a bundled local terminal page with no network access (`src/features/terminal/TerminalWebView.tsx`). The setup-guide link opens runpane.com in Safari, outside the app. |
| User-generated content | No | Nothing is shared with other users. The user sees only their own computer's terminals. |
| Messaging and chat | No | The app doesn't let people talk to each other. Prompts go to the user's own agents. |
| Advertising | No | The app shows no ads. |

## Mature themes, medical or wellness, sexuality or nudity, violence

Answer **None** to every item in these sections: profanity or crude humor; horror or fear themes; alcohol, tobacco or drug references; medical or treatment information; health or wellness topics; mature or suggestive themes; sexual content or nudity; cartoon, realistic or graphic violence; guns or other weapons.

Reason: the app ships no content. It displays terminal text from tools the user chose to run on their own machine, like a terminal or SSH client.

## Chance-based activities

Answer **No** to simulated gambling, contests, gambling and loot boxes. The app has none of these, and no purchases.

## UNSURE

- **UNSURE: AI-generated output.** The agents' output is unfiltered AI text. As of this writing the questionnaire has no separate question for AI output. If App Store Connect shows one when you fill this in, answer that the AI runs on the user's own computer, under the user's own agent account, and that the app only displays its terminal output. Don't change the other answers.
