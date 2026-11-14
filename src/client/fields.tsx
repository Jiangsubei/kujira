import React from 'react';
import { fieldStyle } from './card-styles.js';

export interface ValueFieldProps {
  id: string;
  label: string;
  hint?: string;
  placeholder?: string;
  value: string;
  disabled?: boolean;
  numeric?: boolean;
  inputType?: 'text' | 'password' | 'number';
  autoComplete?: string;
  overridden?: boolean;
  statusBadge?: React.ReactNode;
  onReset?: () => void;
  onChange: (value: string) => void;
}

export function ValueField(props: ValueFieldProps): React.JSX.Element {
  const resolvedType = props.inputType ?? (props.numeric ? 'number' : 'text');
  return (
    <div className={fieldStyle.field}>
      <div className={fieldStyle.head}>
        <label htmlFor={props.id} className={fieldStyle.label}>
          {props.label}
        </label>
        <div className={fieldStyle.badges}>
          {props.statusBadge}
          {props.overridden && (
            <>
              <span className={fieldStyle.badge}>已自定义</span>
              {props.onReset && (
                <button
                  type="button"
                  className={fieldStyle.reset}
                  disabled={props.disabled}
                  onClick={props.onReset}
                >
                  重置
                </button>
              )}
            </>
          )}
        </div>
      </div>
      <input
        id={props.id}
        type={resolvedType}
        autoComplete={props.autoComplete}
        className={fieldStyle.input}
        placeholder={props.placeholder}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {props.hint && <p className={fieldStyle.hint}>{props.hint}</p>}
    </div>
  );
}

export interface TextAreaFieldProps {
  id: string;
  label: string;
  hint?: string;
  placeholder?: string;
  value: string;
  disabled?: boolean;
  overridden?: boolean;
  onReset?: () => void;
  onChange: (value: string) => void;
}

export function TextAreaField(props: TextAreaFieldProps): React.JSX.Element {
  return (
    <div className={fieldStyle.field}>
      <div className={fieldStyle.head}>
        <label htmlFor={props.id} className={fieldStyle.label}>
          {props.label}
        </label>
        <div className={fieldStyle.badges}>
          {props.overridden && (
            <>
              <span className={fieldStyle.badge}>已自定义</span>
              {props.onReset && (
                <button
                  type="button"
                  className={fieldStyle.reset}
                  disabled={props.disabled}
                  onClick={props.onReset}
                >
                  重置
                </button>
              )}
            </>
          )}
        </div>
      </div>
      <textarea
        id={props.id}
        className={fieldStyle.textarea}
        placeholder={props.placeholder}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {props.hint && <p className={fieldStyle.hint}>{props.hint}</p>}
    </div>
  );
}

export interface SwitchFieldProps {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  overridden?: boolean;
  onReset?: () => void;
  onChange: (checked: boolean) => void;
}

export function SwitchField(props: SwitchFieldProps): React.JSX.Element {
  return (
    <div className={[fieldStyle.field, fieldStyle.switchRow].join(' ')}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className={fieldStyle.head}>
          <label htmlFor={props.id} className={fieldStyle.label}>
            {props.label}
          </label>
          <div className={fieldStyle.badges}>
            {props.overridden && (
              <>
                <span className={fieldStyle.badge}>已自定义</span>
                {props.onReset && (
                  <button
                    type="button"
                    className={fieldStyle.reset}
                    disabled={props.disabled}
                    onClick={props.onReset}
                  >
                    重置
                  </button>
                )}
              </>
            )}
          </div>
        </div>
        {props.hint && <p className={fieldStyle.hint}>{props.hint}</p>}
      </div>
      <input
        id={props.id}
        type="checkbox"
        className={fieldStyle.checkbox}
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
      />
    </div>
  );
}

export interface SegmentedOption<T extends string = string> {
  value: T;
  label: string;
}

export interface SegmentedFieldProps<T extends string = string> {
  id: string;
  label: string;
  hint?: string;
  value: T;
  options: SegmentedOption<T>[];
  disabled?: boolean;
  overridden?: boolean;
  statusBadge?: React.ReactNode;
  onReset?: () => void;
  onChange: (value: T) => void;
}

export function SegmentedField<T extends string = string>(
  props: SegmentedFieldProps<T>
): React.JSX.Element {
  const {
    id,
    label,
    hint,
    value,
    options,
    disabled,
    overridden,
    statusBadge,
    onReset,
    onChange,
  } = props;

  return (
    <div className={fieldStyle.field}>
      <div className={fieldStyle.head}>
        <label id={`${id}-label`} htmlFor={id} className={fieldStyle.label}>
          {label}
        </label>
        <div className={fieldStyle.badges}>
          {statusBadge}
          {overridden && (
            <>
              <span className={fieldStyle.badge}>已自定义</span>
              {onReset && (
                <button
                  type="button"
                  className={fieldStyle.reset}
                  disabled={disabled}
                  onClick={onReset}
                >
                  重置
                </button>
              )}
            </>
          )}
        </div>
      </div>
      <div
        id={id}
        data-testid={id}
        role="radiogroup"
        aria-labelledby={`${id}-label`}
        className={fieldStyle.segContainer}
      >
        {options.map((opt) => {
          const isSelected = opt.value === value;
          const optId = `${id}-option-${opt.value}`;
          return (
            <button
              key={opt.value}
              id={optId}
              data-testid={optId}
              type="button"
              role="radio"
              aria-checked={isSelected}
              disabled={disabled}
              className={`${fieldStyle.segBtn}${isSelected ? ` ${fieldStyle.segBtnActive}` : ''}`}
              onClick={() => {
                if (!disabled && opt.value !== value) {
                  onChange(opt.value);
                }
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      {hint && <p className={fieldStyle.hint}>{hint}</p>}
    </div>
  );
}
