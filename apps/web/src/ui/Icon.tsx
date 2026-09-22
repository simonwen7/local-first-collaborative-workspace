interface IconProps {
  readonly name: IconName;
  readonly size?: number;
}

export type IconName =
  | 'layers'
  | 'file'
  | 'plus'
  | 'link'
  | 'play'
  | 'offline'
  | 'online'
  | 'activity'
  | 'close'
  | 'users';

const PATHS: Record<IconName, string> = {
  layers: 'M12 3 3 7.5l9 4.5 9-4.5L12 3Zm9 9-9 4.5L3 12m18 4.5L12 21l-9-4.5',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Zm0 0v5h5',
  plus: 'M12 5v14M5 12h14',
  link: 'M9.5 14.5 14.5 9.5M8 12l-2 2a3.5 3.5 0 0 0 5 5l2-2m1-6 2-2a3.5 3.5 0 0 0-5-5l-2 2',
  play: 'M8 5.5v13l11-6.5L8 5.5Z',
  offline:
    'M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 4-2.5M19 13a10 10 0 0 0-7-3M12 20h.01',
  online: 'M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 20h.01M2 9a15 15 0 0 1 20 0',
  activity: 'M3 12h4l2.5-7 4 14L16 12h5',
  close: 'M6 6l12 12M18 6 6 18',
  users:
    'M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19m9.5-14.3a3.5 3.5 0 0 1 0 6.6M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm10 8v-1.5a3.5 3.5 0 0 0-2.5-3.35',
};

export function Icon({ name, size = 15 }: IconProps) {
  return (
    <svg
      className="btn__glyph"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
