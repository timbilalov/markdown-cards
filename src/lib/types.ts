export interface CardSection {
  heading: string;
  type: 'unordered' | 'ordered' | 'checklist';
  items: {
    text: string;
    checked: boolean;
  }[];
}

export interface CardMeta {
  id: string;
  created: number; // Timestamp
  modified: number; // Timestamp
}

export interface Card {
  title: string;
  meta: CardMeta;
  description: string;
  sections: CardSection[];
}
