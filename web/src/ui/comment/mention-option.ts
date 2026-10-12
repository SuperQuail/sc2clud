import { MenuOption } from '@lexical/react/LexicalTypeaheadMenuPlugin';
import type { MentionCandidate } from './mention-types';

// 官方 LexicalTypeaheadMenuPlugin 要求选项是 MenuOption 的子类（它用 key 做选中标识）。
export class MentionOption extends MenuOption {
  candidate: MentionCandidate;
  constructor(candidate: MentionCandidate) {
    super(candidate.id);
    this.candidate = candidate;
  }
}
