# yAI Code for VS Code

The yAI Code agent in a VS Code side panel. Ask it to change your project; each edit opens as a diff in the editor, and you approve or reject it in the panel.

## Install

1. Install yAI Code once (it signs in to your yAI account):

   ```
   git clone https://github.com/yousefk07/yAI.git
   cd yAI && npm link
   yai          # sign in, then /exit
   ```

2. Install the extension: in VS Code, open the Extensions view, click `…` > **Install from VSIX…** and choose `yai-code.vsix` from the yAI folder's `vscode` folder (or run `code --install-extension vscode/yai-code.vsix`).

3. Open a project folder and click the **yAI** icon in the activity bar.

## Use

- Type a request and press Enter. `@file` mentions a file, `/compact`, `/clone`, `/resume` and the other yAI Code commands work too.
- **Approvals**: *Ask before edits* shows each change as a diff with Yes / No; *Auto-approve edits* applies them; *Plan* only reads and proposes a plan, then asks to go ahead.
- Right-click in an editor: **yAI: Ask about this code** (Ctrl+Alt+Y) puts the file and selected lines in the box; **yAI: Fix the problems in this file** sends VS Code's errors and warnings to yAI.
- The cost of yAI Ultra this session, and today against your allowance, shows at the top right.

## Settings

`yai.command`: how to start yAI Code. `yai` works after `npm link`; otherwise give the full path to `cli/index.js` in your yAI folder.
