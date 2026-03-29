import { ChevronLeft } from 'lucide-react';
import { SECTION_META } from './sectionMeta';
import styles from '../../App.module.css';

export default function SectionBar({ section, onBack }) {
  const meta = SECTION_META[section];
  if (!meta) return null;
  const { Icon, label } = meta;
  return (
    <div className={styles.sectionBar}>
      {onBack && (
        <button className={styles.sectionBarBack} onClick={onBack} aria-label="Volver">
          <ChevronLeft size={18} />
        </button>
      )}
      <Icon size={14} className={styles.sectionBarIcon} aria-hidden="true" />
      <span className={styles.sectionBarTitle}>{label}</span>
    </div>
  );
}
