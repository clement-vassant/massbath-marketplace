import { expect, test } from 'claude-code/testing'

import { tablesToLists } from './register'

test('a markdown table becomes a list, one item per row', async () => {
  const md = [
    'Intro',
    '',
    '| Fichier | Changement | Pourquoi |',
    '|---|:---:|---|',
    '| `Actions.java` | champ `a \\| b`, `x | y` | bandeaux |',
    '| `ActionsAssert.java` |  | tâches 4 et 5 |',
    '',
    'Fin',
  ].join('\n')

  expect(tablesToLists(md)).toBe(
    [
      'Intro',
      '',
      '- **Fichier** : `Actions.java`',
      '  - **Changement** : champ `a | b`, `x | y`',
      '  - **Pourquoi** : bandeaux',
      '- **Fichier** : `ActionsAssert.java`',
      '  - **Pourquoi** : tâches 4 et 5',
      '',
      'Fin',
    ].join('\n'),
  )
})

test('tables inside code fences and plain pipes are left alone', async () => {
  const md = ['```', '| a | b |', '|---|---|', '| 1 | 2 |', '```', 'a | b'].join('\n')
  expect(tablesToLists(md)).toBe(md)
})

test('a table ending the text is converted', async () => {
  expect(tablesToLists('| A | B |\n| - | - |\n| 1 | 2 |')).toBe('- **A** : 1\n  - **B** : 2')
})
