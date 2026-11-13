import { addDays, format, parseISO } from 'date-fns';
import { BookItem, FollowedAuthor, ReadingChallenge, TrackerState } from '@/types/books';

/**
 * A sample library used only when the app is opened with `?demo` in the URL.
 * It is never written to localStorage or the cloud, so it is safe for previewing
 * the design with realistic content.
 */
export function buildDemoLibrary(todayStr: string): TrackerState {
  const today = parseISO(todayStr);
  const nowIso = new Date().toISOString();
  const day = (offset: number) => format(addDays(today, offset), 'yyyy-MM-dd');
  const year = Number(todayStr.slice(0, 4));
  const ol = (isbn: string) => `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg?default=false`;

  const authors: FollowedAuthor[] = [
    { id: 'demo:a:rooney', source: 'manual', name: 'Sally Rooney', followedAt: nowIso, updatedAt: nowIso },
    { id: 'demo:a:ishiguro', source: 'manual', name: 'Kazuo Ishiguro', followedAt: nowIso, updatedAt: nowIso },
    { id: 'demo:a:kuang', source: 'manual', name: 'R.F. Kuang', followedAt: nowIso, updatedAt: nowIso },
    { id: 'demo:a:henry', source: 'manual', name: 'Emily Henry', followedAt: nowIso, updatedAt: nowIso },
    {
      id: 'demo:a:ashdown',
      source: 'manual',
      name: 'Marguerite Ashdown',
      bio: 'Novelist of the English fens; three-time Costa shortlistee.',
      followedAt: nowIso,
      updatedAt: nowIso,
    },
    { id: 'demo:a:wren', source: 'manual', name: 'Tobias Wren', followedAt: nowIso, updatedAt: nowIso },
  ];

  const base = (b: Partial<BookItem> & Pick<BookItem, 'id' | 'title' | 'authorName'>): BookItem => ({
    source: 'manual',
    datePrecision: 'day',
    isOneOff: false,
    isManual: false,
    readingStatus: 'none',
    updatedAt: nowIso,
    ...b,
  });

  const books: BookItem[] = [
    // ---- Forthcoming ----
    base({ id: 'demo:b:1', title: 'The Salt Orchard', authorName: 'Marguerite Ashdown', authorId: 'demo:a:ashdown', releaseDate: day(2), readingStatus: 'todo', addedToTodoAt: nowIso }),
    base({ id: 'demo:b:2', title: 'A Grammar of Rivers', authorName: 'Tobias Wren', authorId: 'demo:a:wren', releaseDate: day(4) }),
    base({ id: 'demo:b:3', title: 'Letters to the Lighthouse Keeper', authorName: 'Ines Halloran', releaseDate: day(9), isOneOff: true }),
    base({ id: 'demo:b:4', title: 'The Cartographer’s Daughter', authorName: 'Tobias Wren', authorId: 'demo:a:wren', releaseDate: day(11), pageCount: 384 }),
    base({ id: 'demo:b:5', title: 'Winter Hours', authorName: 'Marguerite Ashdown', authorId: 'demo:a:ashdown', releaseDate: day(26) }),
    base({ id: 'demo:b:6', title: 'An Inventory of Small Hours', authorName: 'Ines Halloran', releaseDate: format(addDays(today, 70), 'yyyy-MM'), datePrecision: 'month', isOneOff: true }),
    base({ id: 'demo:b:7', title: 'Untitled Novel', authorName: 'Kazuo Ishiguro', authorId: 'demo:a:ishiguro', releaseDate: String(year + 1), datePrecision: 'year' }),

    // ---- Published ----
    base({ id: 'demo:b:10', title: 'Intermezzo', authorName: 'Sally Rooney', authorId: 'demo:a:rooney', releaseDate: '2024-09-24', coverUrl: ol('9780374602635'), readingStatus: 'read', finishedAt: `${year}-02-11`, rating: 5, notes: 'Two brothers, one grief, and Rooney’s best sentences yet.' }),
    base({ id: 'demo:b:11', title: 'Klara and the Sun', authorName: 'Kazuo Ishiguro', authorId: 'demo:a:ishiguro', releaseDate: '2021-03-02', coverUrl: ol('9780593318171'), readingStatus: 'read', finishedAt: `${year}-01-19`, rating: 4 }),
    base({ id: 'demo:b:12', title: 'Babel', authorName: 'R.F. Kuang', authorId: 'demo:a:kuang', releaseDate: '2022-08-23', coverUrl: ol('9780063021426'), readingStatus: 'read', finishedAt: `${year}-03-30`, rating: 4 }),
    base({ id: 'demo:b:13', title: 'Yellowface', authorName: 'R.F. Kuang', authorId: 'demo:a:kuang', releaseDate: '2023-05-16', coverUrl: ol('9780063250833'), readingStatus: 'todo', addedToTodoAt: nowIso }),
    base({ id: 'demo:b:14', title: 'Funny Story', authorName: 'Emily Henry', authorId: 'demo:a:henry', releaseDate: '2024-04-23', coverUrl: ol('9780593441282'), readingStatus: 'read', finishedAt: `${year}-06-02`, rating: 3 }),
    base({ id: 'demo:b:15', title: 'Beautiful World, Where Are You', authorName: 'Sally Rooney', authorId: 'demo:a:rooney', releaseDate: '2021-09-07', coverUrl: ol('9780374602604') }),
    base({ id: 'demo:b:16', title: 'Normal People', authorName: 'Sally Rooney', authorId: 'demo:a:rooney', releaseDate: '2019-04-16', coverUrl: ol('9781984822185'), readingStatus: 'read', finishedAt: `${year - 1}-08-14`, rating: 5 }),
    base({ id: 'demo:b:17', title: 'The Remains of the Day', authorName: 'Kazuo Ishiguro', authorId: 'demo:a:ishiguro', releaseDate: '1989', datePrecision: 'year', coverUrl: ol('9780679731726'), readingStatus: 'read', finishedAt: `${year}-04-21`, rating: 5, notes: 'Restraint as a moral catastrophe. Stevens will stay with me.' }),
    base({ id: 'demo:b:18', title: 'Happy Place', authorName: 'Emily Henry', authorId: 'demo:a:henry', releaseDate: '2023-04-25', coverUrl: ol('9780593441275') }),
    base({ id: 'demo:b:19', title: 'The Fen Wife', authorName: 'Marguerite Ashdown', authorId: 'demo:a:ashdown', releaseDate: day(-5), readingStatus: 'todo', addedToTodoAt: nowIso, pageCount: 312 }),
    base({ id: 'demo:b:20', title: 'Never Let Me Go', authorName: 'Kazuo Ishiguro', authorId: 'demo:a:ishiguro', releaseDate: '2005-03-03', coverUrl: ol('9781400078776'), readingStatus: 'read', finishedAt: `${year}-07-09`, rating: 4 }),
    base({ id: 'demo:b:21', title: 'Conversations with Friends', authorName: 'Sally Rooney', authorId: 'demo:a:rooney', releaseDate: '2017-05-30', coverUrl: ol('9780451499066'), readingStatus: 'read', finishedAt: `${year}-08-27` }),
    base({ id: 'demo:b:22', title: 'The Buried Giant', authorName: 'Kazuo Ishiguro', authorId: 'demo:a:ishiguro', releaseDate: '2015-03-03', coverUrl: ol('9780307271037'), readingStatus: 'read', finishedAt: `${year}-09-15`, rating: 3 }),
    base({ id: 'demo:b:23', title: 'Book Lovers', authorName: 'Emily Henry', authorId: 'demo:a:henry', releaseDate: '2022-05-03', coverUrl: ol('9780593334836'), readingStatus: 'read', finishedAt: `${year}-10-04`, rating: 4 }),
  ];

  const challenges: ReadingChallenge[] = [
    {
      id: `challenge:${year}`,
      year,
      goalCount: 24,
      title: `${year} Reading Challenge`,
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  ];

  return { authors, books, challenges };
}
