/**
 * The assistant's Skills tab: the built-in workflows (read-only) and the
 * project's own skills (saved in the .hcasm file), searchable; a project
 * skill is written as a SKILL.md text with live validation — Save stays
 * disabled until the frontmatter and body are valid.
 */
import { useMemo, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';

import {
  BUILTIN_SKILLS,
  parseSkill,
  searchSkills,
  skillTemplate,
  useProjectSkills,
  type Skill,
} from '../skills.js';
import styles from './AssistantIsland.module.css';

type Mode =
  | { kind: 'read'; id: string }
  | { kind: 'edit'; previousId: string | null; text: string }
  | null;

export function SkillsTab(): JSX.Element {
  const projectSkills = useProjectSkills((s) => s.skills);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<Mode>(null);
  const [error, setError] = useState<string | null>(null);
  const all = useMemo(() => [...BUILTIN_SKILLS, ...projectSkills], [projectSkills]);
  const listed = useMemo(() => searchSkills(query, all), [query, all]);

  if (mode?.kind === 'edit') {
    const parsed = parseSkill(mode.text, 'project');
    const clash =
      parsed.ok && BUILTIN_SKILLS.some((b) => b.id === parsed.skill.id)
        ? `"${parsed.skill.id}" is a built-in skill; choose another id.`
        : parsed.ok &&
            parsed.skill.id !== mode.previousId &&
            projectSkills.some((s) => s.id === parsed.skill.id)
          ? `A skill "${parsed.skill.id}" exists already.`
          : null;
    const problems = parsed.ok ? (clash ? [clash] : []) : parsed.errors;
    return (
      <div className={styles.skillsEditor}>
        <div className={styles.skillsEditorBar}>
          <strong>{mode.previousId ? `Edit ${mode.previousId}` : 'New project skill'}</strong>
          <span className={styles.spacer} />
          <button type="button" className={styles.textButton} onClick={() => setMode(null)}>
            Cancel
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            disabled={problems.length > 0}
            onClick={() => {
              try {
                const skill = useProjectSkills
                  .getState()
                  .save(mode.text, mode.previousId ?? undefined);
                setMode({ kind: 'read', id: skill.id });
                setError(null);
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause));
              }
            }}
          >
            Save project skill
          </button>
        </div>
        <textarea
          className={styles.skillsText}
          aria-label="Skill file (SKILL.md)"
          spellCheck={false}
          value={mode.text}
          onChange={(event) => setMode({ ...mode, text: event.currentTarget.value })}
          onKeyDown={(event) => {
            // Escape only leaves the field; it never discards the text.
            if (event.key === 'Escape') event.currentTarget.blur();
          }}
        />
        <div className={styles.skillsValidation} role="status" aria-live="polite">
          {problems.length === 0 && !error ? (
            <span className={styles.ok}>
              Valid. Saved with the project (Save the project to keep it).
            </span>
          ) : (
            <ul>
              {[...problems, ...(error ? [error] : [])].map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  const selected = mode?.kind === 'read' ? (all.find((s) => s.id === mode.id) ?? null) : null;
  return (
    <div className={styles.skills}>
      <div className={styles.skillsBar}>
        <input
          className={styles.search}
          type="search"
          placeholder="Search skills"
          aria-label="Search skills"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <button
          type="button"
          className={styles.textButton}
          onClick={() =>
            setMode({ kind: 'edit', previousId: null, text: skillTemplate(nextId(projectSkills)) })
          }
        >
          <Plus size={13} /> New skill
        </button>
      </div>
      <div className={styles.skillsBody}>
        <ul className={styles.skillList} aria-label="Skills">
          {listed.map((skill) => (
            <li key={skill.id}>
              <button
                type="button"
                className={selected?.id === skill.id ? styles.skillItemActive : styles.skillItem}
                onClick={() => setMode({ kind: 'read', id: skill.id })}
              >
                <span className={styles.skillName}>
                  {skill.name}
                  <span className={skill.scope === 'built-in' ? styles.badge : styles.badgeProject}>
                    {skill.scope === 'built-in' ? 'Built-in' : 'Project'}
                  </span>
                </span>
                <span className={styles.skillDescription}>{skill.description}</span>
              </button>
            </li>
          ))}
          {listed.length === 0 ? <li className={styles.empty}>No skill matches.</li> : null}
        </ul>
        {selected ? (
          <SkillView
            skill={selected}
            onEdit={(text) => setMode({ kind: 'edit', previousId: selected.id, text })}
          />
        ) : null}
      </div>
    </div>
  );
}

function SkillView({
  skill,
  onEdit,
}: {
  skill: Skill;
  onEdit: (text: string) => void;
}): JSX.Element {
  return (
    <article className={styles.skillView} aria-label={skill.name}>
      <header className={styles.skillViewHeader}>
        <div>
          <strong>{skill.name}</strong>
          <span className={styles.skillMeta}>
            {skill.id} · v{skill.version} ·{' '}
            {skill.scope === 'built-in' ? 'read-only' : 'saved in this project'}
          </span>
        </div>
        {skill.scope === 'project' ? (
          <div className={styles.skillActions}>
            <button
              type="button"
              className={styles.iconButton}
              aria-label="Edit skill"
              onClick={() => onEdit(skill.text)}
            >
              <Pencil size={13} />
            </button>
            <button
              type="button"
              className={styles.iconButton}
              aria-label="Delete skill"
              onClick={() => useProjectSkills.getState().remove(skill.id)}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ) : null}
      </header>
      <pre className={styles.skillBody}>{skill.body}</pre>
    </article>
  );
}

function nextId(skills: readonly Skill[]): string {
  for (let n = 1; ; n += 1) {
    const id = n === 1 ? 'my-skill' : `my-skill-${n}`;
    if (!skills.some((s) => s.id === id)) return id;
  }
}
