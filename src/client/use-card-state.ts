import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { KujiraFormModel, SettingsConflictError } from './model.js';
import type { BridgePluginConfig, CredentialStatusSummary } from '../types/index.js';
import type {
  CardProps,
  CardController,
  CredentialsInputPayload,
  SettingsTabId,
} from './types.js';

const CONFIG_ENDPOINT = '/plugins/kujira/config';

const DEFAULT_CREDENTIAL_STATUS: CredentialStatusSummary = {
  appId: { configured: false, writable: true },
  appSecret: { configured: false, writable: true },
  ready: false,
};

export function useCardState(
  props: CardProps,
  fallbackBaseDefaults: Partial<BridgePluginConfig>
) {
  const isSection = props.layoutMode === 'section';
  const [expandedState, setExpandedState] = useState(props.initialExpanded ?? false);
  const expanded = isSection ? true : expandedState;
  const setExpanded = useCallback(
    (exp: boolean) => {
      if (!isSection) setExpandedState(exp);
    },
    [isSection]
  );

  const [activeTabState, setActiveTabState] = useState<SettingsTabId>(
    props.initialTab ?? 'connection'
  );
  const activeTab = props.activeTab ?? activeTabState;
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [, setRerenderKey] = useState(0);

  // 只写凭据草稿（绝不从后端读取明文填充，提交成功后立即清空）
  const [appIdInput, setAppIdInput] = useState('');
  const [appSecretInput, setAppSecretInput] = useState('');

  const activeTabRef = useRef<SettingsTabId>(activeTab);
  activeTabRef.current = activeTab;
  const errRef = useRef<string | null>(errorMessage);
  errRef.current = errorMessage;
  const savingRef = useRef<boolean>(saving);
  savingRef.current = saving;
  const expandedRef = useRef<boolean>(expanded);
  expandedRef.current = expanded;
  const appIdInputRef = useRef<string>(appIdInput);
  appIdInputRef.current = appIdInput;
  const appSecretInputRef = useRef<string>(appSecretInput);
  appSecretInputRef.current = appSecretInput;

  const updateError = (msg: string | null) => {
    errRef.current = msg;
    setErrorMessage(msg);
  };

  const model = useMemo(() => {
    return new KujiraFormModel({
      initialValues: props.initialConfig || {},
      revision: props.revision ?? 0,
      baseDefaults: props.baseDefaults || fallbackBaseDefaults,
    });
  }, [props.initialConfig, props.baseDefaults, fallbackBaseDefaults]);

  useEffect(() => {
    if (props.revision !== undefined) {
      model.setRevision(props.revision);
    }
  }, [props.revision, model]);

  const forceUpdate = useCallback(() => {
    setRerenderKey((k) => k + 1);
  }, []);

  const isExternalControlled = Boolean(
    (props.initialConfig && Object.keys(props.initialConfig).length > 0) ||
      props.onSaveSettings ||
      props.credentialsStatus
  );

  const [remoteLoaded, setRemoteLoaded] = useState(false);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteLoadError, setRemoteLoadError] = useState<string | null>(null);
  const [remoteCredentialsStatus, setRemoteCredentialsStatus] =
    useState<CredentialStatusSummary | null>(null);
  const remoteCredsRef = useRef<CredentialStatusSummary | null>(null);

  const updateRemoteCredentialsStatus = useCallback((next: CredentialStatusSummary) => {
    remoteCredsRef.current = next;
    setRemoteCredentialsStatus(next);
  }, []);

  const loadRemoteConfig = useCallback(async () => {
    setRemoteLoading(true);
    setRemoteLoadError(null);
    try {
      const res = await fetch(CONFIG_ENDPOINT);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data?.ok) {
        if (data.config) {
          model.setInitialValues(data.config);
        }
        if (data.baseDefaults) {
          model.setBaseDefaults(data.baseDefaults);
        }
        if (data.credentials) {
          updateRemoteCredentialsStatus(data.credentials);
        }
        setRemoteLoaded(true);
        forceUpdate();
      } else {
        throw new Error(data?.error || 'Failed to load configuration');
      }
    } catch (err: any) {
      console.warn('[kujira] Failed to fetch remote config:', err);
      setRemoteLoadError(err?.message || '加载配置失败');
    } finally {
      setRemoteLoading(false);
    }
  }, [model, forceUpdate, updateRemoteCredentialsStatus]);

  useEffect(() => {
    if (!isExternalControlled && !remoteLoaded) {
      void loadRemoteConfig();
    }
  }, [isExternalControlled, remoteLoaded, loadRemoteConfig]);

  const handleTabClick = (tabId: SettingsTabId) => {
    activeTabRef.current = tabId;
    setActiveTabState(tabId);
    props.onTabChange?.(tabId);
    forceUpdate();
  };

  const handleFieldChange = (key: keyof BridgePluginConfig, val: any) => {
    model.setField(key, val);
    updateError(null);
    forceUpdate();
  };

  const handleAppIdChange = (val: string) => {
    appIdInputRef.current = val;
    setAppIdInput(val);
    updateError(null);
    forceUpdate();
  };

  const handleAppSecretChange = (val: string) => {
    appSecretInputRef.current = val;
    setAppSecretInput(val);
    updateError(null);
    forceUpdate();
  };

  const handleResetField = (key: keyof BridgePluginConfig) => {
    model.resetField(key);
    forceUpdate();
  };

  const handleDiscard = () => {
    model.discard();
    appIdInputRef.current = '';
    appSecretInputRef.current = '';
    setAppIdInput('');
    setAppSecretInput('');
    updateError(null);
    forceUpdate();
  };

  const clearCredentialDrafts = () => {
    appIdInputRef.current = '';
    appSecretInputRef.current = '';
    setAppIdInput('');
    setAppSecretInput('');
  };

  const handleSave = async () => {
    savingRef.current = true;
    setSaving(true);
    updateError(null);
    try {
      const trimmedAppId = appIdInputRef.current.trim();
      const trimmedAppSecret = appSecretInputRef.current.trim();
      const credPayload: CredentialsInputPayload | undefined =
        trimmedAppId || trimmedAppSecret
          ? {
              ...(trimmedAppId ? { app_id: trimmedAppId } : {}),
              ...(trimmedAppSecret ? { app_secret: trimmedAppSecret } : {}),
            }
          : undefined;

      if (props.onSaveSettings) {
        const res = await model.save({
          saveSettings: props.onSaveSettings,
          ...(credPayload ? { extraPayload: { credentials: credPayload } } : {}),
        });
        if (res && res.credentials) {
          updateRemoteCredentialsStatus(res.credentials);
        }
        clearCredentialDrafts();
      } else {
        const dirtyDraft = model.getDraft();
        const bodyPayload = credPayload
          ? { ...dirtyDraft, credentials: credPayload }
          : dirtyDraft;
        const res = await fetch(CONFIG_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(bodyPayload),
        });
        let data: any = null;
        try {
          data = await res.json();
        } catch {
          // 非 JSON 响应交由下方状态码兜底
        }
        if (!res.ok || !data?.ok) {
          throw new Error(data?.error || `HTTP ${res.status}`);
        }
        if (data.credentials) {
          updateRemoteCredentialsStatus(data.credentials);
        }
        model.markClean();
        clearCredentialDrafts();
      }
      forceUpdate();
    } catch (err: any) {
      if (err instanceof SettingsConflictError || err?.code === 'SETTINGS_CONFLICT') {
        updateError('保存冲突: 配置已被其他标签页修改，请刷新后重试。');
      } else {
        updateError(err?.message || '保存失败，请检查配置');
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const draft = model.getDraft();
  const hasCredDraft = Boolean(appIdInput.trim() || appSecretInput.trim());
  const isDirty = model.isDirty() || hasCredDraft;
  const blocked = !isDirty || saving;
  const credentialsStatus =
    remoteCredentialsStatus ?? props.credentialsStatus ?? DEFAULT_CREDENTIAL_STATUS;

  const propsCredStatusRef = useRef<CredentialStatusSummary | undefined>(props.credentialsStatus);
  propsCredStatusRef.current = props.credentialsStatus;

  const controller: CardController = {
    get activeTab() {
      return activeTabRef.current;
    },
    setActiveTab: handleTabClick,
    model,
    get expanded() {
      return expandedRef.current;
    },
    setExpanded: (exp: boolean) => {
      expandedRef.current = exp;
      setExpanded(exp);
    },
    get isDirty() {
      return (
        model.isDirty() ||
        Boolean(appIdInputRef.current.trim() || appSecretInputRef.current.trim())
      );
    },
    get saving() {
      return savingRef.current;
    },
    get errorMessage() {
      return errRef.current;
    },
    get credentialsStatus() {
      return remoteCredsRef.current ?? propsCredStatusRef.current ?? DEFAULT_CREDENTIAL_STATUS;
    },
    get appIdInput() {
      return appIdInputRef.current;
    },
    get appSecretInput() {
      return appSecretInputRef.current;
    },
    handleAppIdChange,
    handleAppSecretChange,
    handleFieldChange,
    handleResetField,
    handleDiscard,
    handleSave,
  };

  if (props.controllerRef) {
    if (typeof props.controllerRef === 'function') {
      props.controllerRef(controller);
    } else {
      props.controllerRef.current = controller;
    }
  }

  return {
    expanded,
    setExpanded,
    activeTab,
    handleTabClick,
    model,
    draft,
    saving,
    errorMessage,
    updateError,
    credentialsStatus,
    appIdInput,
    appSecretInput,
    isDirty,
    blocked,
    remoteLoading,
    remoteLoadError,
    handleAppIdChange,
    handleAppSecretChange,
    handleFieldChange,
    handleResetField,
    handleDiscard,
    handleSave,
  };
}
