import React, { useState, useEffect } from 'react';
import { PlusIcon } from '@heroicons/react/24/outline';
import ReactMarkdown from 'react-markdown';
import { API_BASE_URL } from '../services/api';

interface Skill {
  name: string;
  type: 'pre-installed' | 'custom';
  characterCount?: number;
}

interface SkillContent extends Skill {
  content: string;
}

function SkillMarkdown({ content }: { content: string }): JSX.Element {
  return (
    <div className="skill-markdown max-w-none text-text-primary">
      <ReactMarkdown
        components={{
          h1: ({ children, ...props }) => <h1 className="text-3xl font-bold my-3" {...props}>{children}</h1>,
          h2: ({ children, ...props }) => <h2 className="text-2xl font-semibold my-2.5" {...props}>{children}</h2>,
          h3: ({ children, ...props }) => <h3 className="text-xl font-semibold my-2" {...props}>{children}</h3>,
          p: ({ children, ...props }) => <p className="mb-3 leading-relaxed" {...props}>{children}</p>,
          ul: ({ children, ...props }) => <ul className="list-disc pl-6 mb-3 space-y-1" {...props}>{children}</ul>,
          ol: ({ children, ...props }) => <ol className="list-decimal pl-6 mb-3 space-y-1" {...props}>{children}</ol>,
          li: ({ children, ...props }) => <li className="leading-relaxed" {...props}>{children}</li>,
          strong: ({ children, ...props }) => <strong className="font-semibold" {...props}>{children}</strong>,
          em: ({ children, ...props }) => <em className="italic" {...props}>{children}</em>,
          code: ({ children, ...props }) => (
            <code className="font-mono text-sm bg-bg-surface rounded px-1 py-0.5" {...props}>
              {children}
            </code>
          ),
          pre: ({ children, ...props }) => <pre className="bg-bg-surface rounded-lg p-3 overflow-x-auto" {...props}>{children}</pre>,
          blockquote: ({ children, ...props }) => (
            <blockquote className="border-l-4 border-accent pl-4 italic text-text-secondary my-3" {...props}>{children}</blockquote>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export const SkillsPage: React.FC = () => {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<SkillContent | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editContent, setEditContent] = useState('');
  const [, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMarkdownPreview, setShowMarkdownPreview] = useState(true);

  const fetchSkills = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/skills`);
      const json = await res.json();
      if (json.success) {
        setSkills(json.data);
      } else {
        setError(json.error);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchSkillContent = async (name: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/api/skills/${name}`);
      const json = await res.json();
      if (json.success) {
        setSelectedSkill(json.data);
        setIsEditing(false);
      } else {
        setError(json.error);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const deleteSkill = async (name: string) => {
    if (!confirm(`Delete skill "${name}"? This cannot be undone.`)) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/api/skills/${name}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        setSelectedSkill(null);
        await fetchSkills();
      } else {
        setError(json.error);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  };

  const saveSkill = async () => {
    if (!editName || !editContent) return;
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/skills/${editName}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editContent }),
      });
      const json = await res.json();
      if (json.success) {
        await fetchSkills();
        fetchSkillContent(editName);
      } else {
        setError(json.error);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    fetchSkills();
  }, []);

  return (
    <div className="flex h-full min-h-[600px] overflow-hidden -m-4">
      <div className="w-1/3 flex flex-col bg-bg-surface2">
        <div className="px-5 py-4 flex justify-between items-center">
          <h2 className="text-lg font-semibold text-text-primary">All Skills</h2>
          <button
            onClick={() => {
              setSelectedSkill(null);
              setEditName('');
              setEditContent('');
              setIsEditing(true);
            }}
            className="p-2 bg-accent text-white rounded-lg hover:bg-accent-hover flex items-center gap-1 text-sm"
          >
            <PlusIcon className="w-4 h-4" /> Create
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {skills.map(s => (
            <div
              key={s.name}
              onClick={() => fetchSkillContent(s.name)}
              className={`p-3 rounded-lg cursor-pointer transition-colors ${selectedSkill?.name === s.name && !isEditing ? 'bg-bg-surface' : 'hover:bg-bg-surface'}`}
            >
              <h3 className="text-md font-medium text-text-primary">{s.name}</h3>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className={`text-xs px-2 py-0.5 rounded-full ${s.type === 'custom' ? 'bg-success-soft text-success' : 'bg-info-soft text-info'}`}>
                  {s.type}
                </span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-bg-surface text-text-secondary">
                  {(s.characterCount ?? 0).toLocaleString()} chars
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

          <div className="flex-1 flex flex-col bg-bg-surface">
        {error && (
          <div className="m-4 p-4 bg-danger-soft text-danger rounded-lg text-sm">{error}</div>
        )}

        {isEditing ? (
          <div className="flex-1 flex flex-col p-6">
            <h2 className="text-xl font-bold mb-4 text-text-primary">Create / Edit Custom Skill</h2>
            <input
              type="text"
              placeholder="Skill filename (e.g. strict-typing)"
              value={editName}
              onChange={e => setEditName(e.target.value)}
              disabled={selectedSkill?.type === 'pre-installed'}
              className="mb-4 p-3 rounded-lg bg-bg-elevated text-text-primary"
            />
            <textarea
              placeholder="Markdown content for your skill..."
              value={editContent}
              onChange={e => setEditContent(e.target.value)}
              className="flex-1 p-4 rounded-lg bg-bg-elevated text-text-primary font-mono text-sm resize-none"
            />
            <div className="mt-4 flex justify-end gap-3">
              <button
                onClick={() => setShowMarkdownPreview((prev) => !prev)}
                className="px-3 py-2 border border-border rounded-lg text-text-secondary hover:bg-bg-surface2"
              >
                {showMarkdownPreview ? 'Hide' : 'Show'} Markdown Preview
              </button>
            </div>
            {showMarkdownPreview && (
              <div className="flex-1 mt-3 rounded-lg bg-bg-elevated p-4 overflow-auto">
                <div className="text-sm text-text-secondary mb-2">Markdown Preview</div>
                <SkillMarkdown content={editContent} />
              </div>
            )}
            <div className="mt-4 flex justify-end gap-3">
              <button
                onClick={() => setIsEditing(false)}
                className="px-6 py-2 border border-border rounded-lg text-text-secondary hover:bg-bg-surface2"
              >
                Cancel
              </button>
              <button
                onClick={saveSkill}
                disabled={saving || !editName || !editContent}
                className="px-6 py-2 bg-accent text-white rounded-lg hover:bg-accent-hover disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Skill'}
              </button>
            </div>
          </div>
        ) : selectedSkill ? (
          <div className="flex-1 flex flex-col">
            <div className="p-5 pr-8 flex justify-between items-center bg-bg-surface2">
              <div className="leading-tight">
                <h2 className="text-xl font-bold text-text-primary">{selectedSkill.name}.md</h2>
                <span className="text-sm text-text-secondary">{selectedSkill.type} skill</span>
              </div>
              {selectedSkill.type === 'custom' && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      setEditName(selectedSkill.name);
                      setEditContent(selectedSkill.content);
                      setIsEditing(true);
                    }}
                    className="px-4 py-2 bg-bg-elevated rounded-lg text-sm text-text-primary hover:shadow-card"
                  >
                    Edit Skill
                  </button>
                  <button
                    onClick={() => deleteSkill(selectedSkill.name)}
                    disabled={deleting}
                    className="px-4 py-2 bg-danger-soft text-danger rounded-lg text-sm hover:bg-danger hover:text-white transition-colors disabled:opacity-50"
                  >
                    {deleting ? 'Deleting...' : 'Delete'}
                  </button>
                </div>
              )}
            </div>
            <div className="p-8 flex-1 overflow-y-auto max-w-none text-text-primary">
              <SkillMarkdown content={selectedSkill.content} />
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-text-muted">
            Select a skill from the list or create a new one.
          </div>
        )}
      </div>
    </div>
  );
};
