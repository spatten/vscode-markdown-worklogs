// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as MarkdownIt from "markdown-it";
import Token = require('markdown-it/lib/token');

const markdownParser = MarkdownIt();
const TODO_TYPES = ["", "TODO", "DONE"];

enum Direction {
  up = 'up',
  down = 'down',
}

type HeaderInfo = {
  leadingSpace: number;
  level: number;
  trailingSpace: number;
  todoState: string;
  todoIndex: number;
};

const emptyHeader: HeaderInfo = {
  leadingSpace: 0,
  level: 0,
  trailingSpace: 0,
  todoState: '',
  todoIndex: 0
};

export const getHeaderInfo = (lineText: string): HeaderInfo => {
  // match (leading space)(#-signs)(space after #-signs)(first word)
  const match = /^(\s*)([#]+)(\s*)([^ ]*)/.exec(lineText);
  if (!match) { return emptyHeader; }
  const [leading, octos, trailing, firstWord] = match.slice(1);

  let currentIndex = TODO_TYPES.indexOf(firstWord);
  // If firstWord is not 'TODO' or 'DONE', then it's '', the first entry in TODO_TYPES
  if (currentIndex === -1) {
    currentIndex = 0;
  }
  return {
    leadingSpace: leading.length,
    level: octos.length,
    trailingSpace: trailing.length,
    todoIndex: currentIndex,
    todoState: TODO_TYPES[currentIndex],
  };
};

// insert "  CLOSED: yyyy-mm-dd hh:m" after the DONE header
const insertCompletedAt = (editBuilder: vscode.TextEditorEdit, currentLine: number, indent: number) => {
  const d = new Date();
  const padding = ' '.repeat(indent);
  const completedAt = `${padding}CLOSED: [${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${d.getMinutes()}]`;
  editBuilder.insert(new vscode.Position(currentLine + 1, 0), `${completedAt}\n`);
};

const deleteCompletedAt = (editor: vscode.TextEditor, editBuilder: vscode.TextEditorEdit, currentLine: number) => {
  const lineText = editor.document.lineAt(currentLine + 1).text;
  if (lineText.match(/^\s*CLOSED: \[\d\d\d\d-\d{1,2}-\d{1,2} \d{1,2}:\d{1,2}\]\s*$/)) {
    editBuilder.delete(new vscode.Range(new vscode.Position(currentLine + 1, 0), new vscode.Position(currentLine + 2, 0)));
  }
};

// parsed contains an array of tokens. A header token will look like this:
// Token {
//   type: 'heading_open',
//   tag: 'h1',
//   attrs: null,
//   map: [ 0, 1 ],
//   nesting: 1,
//   level: 0,
//   children: null,
//   content: '',
//   markup: '#',
//   info: '',
//   meta: null,
//   block: true,
//   hidden: false
// },
//
// We're looking for headers that have a level of 0. The first entry in the `map` attribute is the line index of the header.
type FilterParams = {
  ignoreCurrent: boolean;
  minLevel?: number;
  exactLevel?: number;
  minLine?: number;
  maxLine?: number;
  currentLine?: number;
};

const headerFilter = (block: Token, params: FilterParams): boolean => {
  const { ignoreCurrent, minLevel, exactLevel, currentLine, minLine, maxLine } = params;
  // must be a top-level header
  // top-level means "not nested inside of another thing". An h2 header can be a top-level header.
  // For example, a header inside of a blockquote or a list is not top-level.
  if (block.level !== 0 || block.type !== 'heading_open') {
    return false;
  }

  // we need a line number
  if (block.map?.[0] === undefined) {
    return false;
  }
  const lineNumber = block.map[0];

  if (minLine !== undefined && lineNumber < minLine) {
    return false;
  }

  if (maxLine !== undefined && lineNumber > maxLine) {
    return false;
  }

  // if we're ignoring the current line, then return if it's the same line
  if (ignoreCurrent && currentLine !== undefined && lineNumber === currentLine) {
    return false;
  }

  // The tag must be of the form "h<digit>"
  if (!block.tag.match(/^h\d$/)) {
    return false;
  }

  const headerLevel = getHeaderLevel(block);
  if (minLevel && headerLevel < minLevel) {
    return false;
  }

  if (exactLevel && headerLevel !== exactLevel) {
    return false;
  }

  return true;
};

const getBlocks = (editor: vscode.TextEditor): Token[] => {
  const fullText = editor.document.getText();
  return markdownParser.parse(fullText, {});
};

type FindHeaderParams = {
  direction: Direction
  ignoreCurrent: boolean;
  startLine?: number;
  minLevel?: number;
  exactLevel?: number;
};

const findHeader = (
  editor: vscode.TextEditor,
  { direction = Direction.down, ignoreCurrent = false, startLine, minLevel, exactLevel }: FindHeaderParams
): number => {
  let currentLine: number;
  if (startLine === undefined) {
    currentLine = editor.selection.active.line;
  } else {
    currentLine = startLine;
  }
  let parsed = getBlocks(editor);
  const filterParams: FilterParams = { ignoreCurrent, minLevel, exactLevel, currentLine };
  if (direction === Direction.up) {
    parsed = parsed.reverse();
    filterParams.maxLine = currentLine;
  } else {
    filterParams.minLine = currentLine;
  }
  const header = parsed.find(block => headerFilter(block, filterParams));
  if (header?.map) {
    return header.map[0];
  }
  return -1;
};

type GotoHeaderParams = {
  direction: Direction;
  minLevel?: number;
  exactLevel?: number;
};

const gotoHeader = (editor: vscode.TextEditor, params: GotoHeaderParams) => {
  const { direction, minLevel, exactLevel } = params;
  const headerLine = findHeader(editor, { direction, ignoreCurrent: true, minLevel, exactLevel });

  if (headerLine >= 0) {
    const position = editor.selection.active;
    const newPosition = new vscode.Position(headerLine, 0);
    let newSelection: vscode.Selection;
    let range: vscode.Range;
    if (editor.selection.isEmpty) {
      newSelection = new vscode.Selection(newPosition, newPosition);
      range = new vscode.Range(newPosition, newPosition);
    } else {
      if (direction === Direction.up) {
        newSelection = new vscode.Selection(editor.selection.end, newPosition);
      } else {
        const headerText = editor.document.lineAt(headerLine).text;
        newSelection = new vscode.Selection(editor.selection.start, newPosition.with(undefined, headerText.length));
      }
      range = new vscode.Range(position, newPosition);
    }
    editor.selection = newSelection;
    editor.revealRange(range, vscode.TextEditorRevealType.Default);
  }
};

enum TodoDirection {
  prev = -1,
  next = 1,
}

const changeTodo = async (editor: vscode.TextEditor, editBuilder: vscode.TextEditorEdit, change: TodoDirection) => {
  const lineIndex = findHeader(editor, { direction: Direction.up, ignoreCurrent: false });
  if (lineIndex < 0) {
    return;
  }

  const lineText = editor.document.lineAt(lineIndex).text;
  const { leadingSpace, level, trailingSpace, todoState: currentState, todoIndex: currentIndex } = getHeaderInfo(lineText);

  // find the next TODO word, looping around in either direction
  let nextIndex = currentIndex + change;
  if (nextIndex >= TODO_TYPES.length) {
    nextIndex = 0;
  }
  if (nextIndex < 0) {
    nextIndex = TODO_TYPES.length - 1;
  }

  // We need to insert an extra space if nextWord is not ''
  let nextWord = TODO_TYPES[nextIndex];
  if (nextWord !== '') {
    nextWord = nextWord + ' ';
  }

  const startPos = leadingSpace + level + trailingSpace;
  const endPos = startPos + currentState.length + 1;
  const replaceRange = new vscode.Range(new vscode.Position(lineIndex, startPos), new vscode.Position(lineIndex, endPos));

  // if the firsst word of the header is not TODO or DONE, then we want to insert TODO or DONE
  // otherwise we want to replace the current TODO or DONE with nextWord
  if (currentIndex < 1) {
    editBuilder.insert(new vscode.Position(lineIndex, startPos), nextWord);
  } else {
    editBuilder.replace(replaceRange, nextWord);
  }

  // add or delete the completedAt text
  if (nextWord === 'DONE ') {
    if (getConfig('insertCompletionTimestamp')) {
      insertCompletedAt(editBuilder, lineIndex, leadingSpace + level + 1);
    }
  } else {
    deleteCompletedAt(editor, editBuilder, lineIndex);
  }
};

// Used by moveAllDoneToBottom
// given a range of lines in doneEntry, move those lines below the line given in lastNonDONELine
// We need to make our own edit builder here as we need to actually run each moveEntryToBottomedit before the next one is run
const moveEntryToBottom = async (editor: vscode.TextEditor, doneEntry: [number, number], lastNonDONELine: number): Promise<number> => {
  let linesMoved = 0;
  await editor.edit((editBuilder) => {
    const replaceRange = new vscode.Range(new vscode.Position(doneEntry[0], 0), new vscode.Position(doneEntry[1] + 1, 0));
    const doneText = editor.document.getText(replaceRange);
    if (doneEntry[0] >= lastNonDONELine) {
      linesMoved = 0;
      return;
    }
    editBuilder.replace(replaceRange, '');
    editBuilder.insert(new vscode.Position(lastNonDONELine + 1, 0), doneText);
    linesMoved = doneEntry[1] - doneEntry[0] + 1;
  });
  return linesMoved;
};

const getHeaderLevel = (block: Token): number => {
  if (!block.tag.match(/^h\d$/)) {
    throw new Error("attempted to get header level on non-header block ${JSON.stringify(block)}");
  }
  return parseInt(block.tag.replace(/^h/, ''));
};

// Sort all of the top-level headers within the current header.
// E.g. if your cursor is currently on a h2 header (or on a non-header line within an h2 header),
// sort all of the h3 headers between the top of this header and the next h2 header
const moveCurrentDoneToBottom = async function (editor: vscode.TextEditor) {
  // Find the start of the current header
  const startLine = findHeader(editor, { direction: Direction.up, ignoreCurrent: false });
  if (startLine < 0) {
    return;
  }
  const lineText = editor.document.lineAt(startLine).text;
  const { level } = getHeaderInfo(lineText);

  // find the end of the current header by looking for the next header of the same level, ignoring the current line
  // If we don't find a header of that level, we'll get -1 instead so set maxLine to the end of the file
  const nextHeaderIndex = findHeader(editor, { direction: Direction.down, ignoreCurrent: true, exactLevel: level });

  let maxLine: number;
  if (nextHeaderIndex === -1) {
    maxLine = editor.document.lineCount - 1;
  } else {
    maxLine = nextHeaderIndex - 1;
  }

  await moveDoneToBottom(editor, { minLine: startLine + 1, maxLine, topLevel: false });
};

// move all top-level DONE sections to the bottom of the file, maintaining their order
const moveAllDoneToBottom = async function (editor: vscode.TextEditor) {
  const minLine = 0;
  const maxLine = editor.document.lineCount - 1;
  await moveDoneToBottom(editor, { minLine, maxLine, topLevel: true });
};

// moveDoneToBottom is an internal function called by moveAllDoneToBottom and moveCurrentDoneToBottom
// if topLevel is false, then only search in the current header and sort the top-level
// of headers found in the selection.
// If topLevel is true, then search the whole file and sort h1 headers
const moveDoneToBottom = async function (editor: vscode.TextEditor, params: { minLine: number, maxLine: number, topLevel: boolean }) {
  const { minLine, maxLine, topLevel } = params;
  const parsed = getBlocks(editor);

  const filterParams: FilterParams = { ignoreCurrent: false, minLine, maxLine };
  let headers = parsed.filter(block => headerFilter(block, filterParams));
  let topLevelHeader = 1;
  if (!topLevel) {
    // find the min header level of the headers in the range
    topLevelHeader = headers.reduce(
      (minLevel: number, currentHeader: Token) => {
        const level = getHeaderLevel(currentHeader);
        if (level < minLevel) {
          return level;
        }
        return minLevel;
      },
      1000
    );
  }
  headers = headers.filter(header => getHeaderLevel(header) === topLevelHeader);

  // get a list of the line ranges for all top-level DONE entries
  // Also, find the last line that is not part of a DONE entry
  let lastNonDONELine = -1;
  let doneEntries: [number, number][] = [];
  headers.forEach((header, n) => {
    const startLine = header.map?.[0];
    if (startLine === undefined || startLine === null) {
      return;
    }
    let endLine;
    if (n < headers.length - 1) {
      const nextMap = headers[n + 1]?.map;
      if (!nextMap) {
        throw new Error("no map found when looking at next header");
      }
      endLine = nextMap[0] - 1;
    } else {
      endLine = maxLine;
    }

    const lineText = editor.document.lineAt(startLine).text;
    const headerInfo = getHeaderInfo(lineText);
    if (headerInfo.todoState === 'DONE') {
      doneEntries.push([startLine, endLine]);
    } else {
      lastNonDONELine = endLine;
    }
  });
  doneEntries = doneEntries.reverse();

  // now, start moving the DONE entries down below lastNonDONELine, maintaining their order
  for (const doneEntry of doneEntries) {
    const linesMoved = await moveEntryToBottom(editor, doneEntry, lastNonDONELine);
    lastNonDONELine -= (linesMoved);
  }
};

const currentCodeblock = (editor: vscode.TextEditor): Token | undefined => {
  const currentLine = editor.selection.active.line;
  const parsed = getBlocks(editor);
  const codeblock = parsed.find(block => codeblockFilter(block, { currentLine }));
  return codeblock;
};

type CodeBlockFilterParams = {
  currentLine: number;
};

const codeblockFilter = (block: Token, params: CodeBlockFilterParams): boolean => {
  const { currentLine } = params;
  if (block.type !== 'fence') {
    return false;
  }
  if (!block.map) {
    return false;
  }
  const [startLine, endLine] = block.map;
  return startLine <= currentLine && endLine >= currentLine;
};

const copyCurrentCodeblock = async (editor: vscode.TextEditor) => {
  const codeblock = currentCodeblock(editor);
  if (!codeblock) {
    return;
  }
  // const code = editor.document.getText(new vscode.Range(codeblock.start, codeblock.end));
  await vscode.env.clipboard.writeText(codeblock.content);
};

const selectCurrentCodeblock = async (editor: vscode.TextEditor) => {
  const codeblock = currentCodeblock(editor);
  if (!codeblock) {
    return;
  }
  if (!codeblock.map) {
    return;
  }
  const [startLine, endLine] = codeblock.map;
  const realStart = startLine + 1;
  const realEnd = endLine > 2 ? endLine - 2 : endLine;
  const lastLine = editor.document.lineAt(realEnd).text;

  editor.selection = new vscode.Selection(new vscode.Position(realStart, 0), new vscode.Position(realEnd, lastLine.length));
};

const getConfig = (param: string): string | undefined => vscode.workspace.getConfiguration('markdown-worklogs').get(param);

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  const increaseTodo = vscode.commands.registerTextEditorCommand('markdown-worklogs.increaseTodo', async (te, edit) => {
    await changeTodo(te, edit, TodoDirection.next);
  });
  context.subscriptions.push(increaseTodo);

  const decreaseTodo = vscode.commands.registerTextEditorCommand('markdown-worklogs.decreaseTodo', async (te, edit) => {
    await changeTodo(te, edit, TodoDirection.prev);
  });
  context.subscriptions.push(decreaseTodo);

  const openCurrentWorklog = vscode.commands.registerCommand('markdown-worklogs.openCurrentWorklog', async () => {
    const worklogDir = getConfig('worklogDirectory');
    if (!worklogDir) {
      throw new Error("Please set your worklog directory in the markdown-worklogs extension settings");
    }

    const entries = await fs.promises.readdir(worklogDir);
    const workLogs = entries.filter(entry => entry.match(/^\d\d\d\d-\d\d-\d\d\.md$/));
    const currentLog = workLogs.sort().reverse()[0];
    const uri = vscode.Uri.file(path.join(worklogDir, currentLog));
    await vscode.commands.executeCommand('vscode.open', uri);
    if (getConfig('foldCurrentWorklog')) {
      vscode.commands.executeCommand('editor.foldAll');
    }
    if (getConfig('pinCurrentWorklog')) {
      vscode.commands.executeCommand('workbench.action.pinEditor');
    }
  });
  context.subscriptions.push(openCurrentWorklog);

  const createNewWorklog = vscode.commands.registerCommand('markdown-worklogs.createNewWorklog', async () => {
    const worklogDir = getConfig('worklogDirectory');
    if (!worklogDir) {
      throw new Error("Please set your worklog directory in the markdown-worklogs extension settings");
    }

    const d = new Date();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const newLog = path.join(worklogDir, `${d.getFullYear()}-${month}-${day}.md`);

    // Make sure the file exists. utimesSync is the equivalent of touch
    const time = new Date();
    try {
      fs.utimesSync(newLog, time, time);
    } catch (err) {
      fs.closeSync(fs.openSync(newLog, 'w'));
    }

    // Open the file in VS Code
    const uri = vscode.Uri.file(newLog);
    await vscode.commands.executeCommand('vscode.open', uri);

    // Fold and pin it
    if (getConfig('foldCurrentWorklog')) {
      vscode.commands.executeCommand('editor.foldAll');
    }
    if (getConfig('pinCurrentWorklog')) {
      vscode.commands.executeCommand('workbench.action.pinEditor');
    }
  });
  context.subscriptions.push(createNewWorklog);

  const gotoPreviousHeader = vscode.commands.registerTextEditorCommand('markdown-worklogs.gotoPreviousHeader', async (te) => {
    gotoHeader(te, { direction: Direction.up });
  });
  context.subscriptions.push(gotoPreviousHeader);

  const gotoNextHeader = vscode.commands.registerTextEditorCommand('markdown-worklogs.gotoNextHeader', async (te) => {
    gotoHeader(te, { direction: Direction.down });
  });
  context.subscriptions.push(gotoNextHeader);

  const gotoPreviousTopLevelHeader = vscode.commands.registerTextEditorCommand('markdown-worklogs.gotoPreviousTopLevelHeader', async (te) => {
    gotoHeader(te, { direction: Direction.up, exactLevel: 1 });
  });
  context.subscriptions.push(gotoPreviousTopLevelHeader);

  const gotoNextTopLevelHeader = vscode.commands.registerTextEditorCommand('markdown-worklogs.gotoNextTopLevelHeader', async (te) => {
    gotoHeader(te, { direction: Direction.down, exactLevel: 1 });
  });
  context.subscriptions.push(gotoNextTopLevelHeader);

  const sortDoneToBottom = vscode.commands.registerTextEditorCommand('markdown-worklogs.sortDoneToBottom', async (te) => {
    moveAllDoneToBottom(te);
  });
  context.subscriptions.push(sortDoneToBottom);

  const sortCurrentDoneToBottom = vscode.commands.registerTextEditorCommand('markdown-worklogs.sortCurrentDoneToBottom', async (te) => {
    moveCurrentDoneToBottom(te);
  });
  context.subscriptions.push(sortCurrentDoneToBottom);

  const findInWorklogs = vscode.commands.registerCommand('markdown-worklogs.findInWorklogs', async () => {
    const editor = vscode.window.activeTextEditor;
    let searchText = '';
    if (editor && !editor.selection.isEmpty) {
      searchText = editor.document.getText(editor.selection);
    } else {
      searchText = await vscode.window.showInputBox({
        placeHolder: "Search query",
        prompt: "Search my snippets on Codever",
        value: '',
      }) || '';
    }

    // 'workbench.action.findInFiles' or 'search.action.openEditor'. They both take the same params
    vscode.commands.executeCommand('search.action.openEditor', {
      query: searchText,
      triggerSearch: true,
      matchWholeWord: true,
      isCaseSensitive: true,
      filesToInclude: getConfig('worklogDirectory'),
    });
  });
  context.subscriptions.push(findInWorklogs);

  const copyCodeblock = vscode.commands.registerTextEditorCommand('markdown-worklogs.copyCurrentCodeblock', async (te) => {
    await copyCurrentCodeblock(te);
  });
  context.subscriptions.push(copyCodeblock);

  const selectCodeblock = vscode.commands.registerTextEditorCommand('markdown-worklogs.selectCurrentCodeblock', async (te) => {
    await selectCurrentCodeblock(te);
  });
  context.subscriptions.push(selectCodeblock);
}

// this method is called when your extension is deactivated
export function deactivate() { }
