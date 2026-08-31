'use strict';

const db = require('./db');
const {
  ACCESS_OPERATIONS,
  ROLE_ALLOWED_OPERATIONS
} = require('./team-members');

const WORKSPACE_HEADER = 'x-trobill-workspace-account-id';
const OPERATION_VALUES = Object.freeze(ACCESS_OPERATIONS.map(operation => operation.value));

class AccountAccessError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'AccountAccessError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function accountId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new AccountAccessError(400, 'INVALID_WORKSPACE_ACCOUNT', 'Tài khoản làm việc không hợp lệ');
  }
  return id;
}

function numericArray(value) {
  return Array.isArray(value)
    ? value.map(Number).filter(Number.isSafeInteger)
    : [];
}

function textArray(value) {
  return Array.isArray(value)
    ? value.map(item => String(item)).filter(item => OPERATION_VALUES.includes(item))
    : [];
}

async function workspaceRows(memberUserId, query = db.query) {
  const result = await query(
    `SELECT membership.account_user_id,
            membership.role,
            owner.email AS account_email,
            CASE WHEN membership.role='owner' THEN
              ARRAY(
                SELECT property.id
                FROM properties property
                WHERE property.user_id=membership.account_user_id
                ORDER BY property.is_default DESC, property.sort_order, property.name, property.id
              )
            ELSE
              ARRAY(
                SELECT access.property_id
                FROM account_member_property_access access
                JOIN properties property
                  ON property.user_id=access.account_user_id AND property.id=access.property_id
                WHERE access.account_user_id=membership.account_user_id
                  AND access.member_user_id=membership.member_user_id
                ORDER BY property.is_default DESC, property.sort_order, property.name, property.id
              )
            END AS property_ids,
            CASE WHEN membership.role='owner' THEN $2::text[] ELSE
              ARRAY(
                SELECT access.operation
                FROM account_member_operation_access access
                WHERE access.account_user_id=membership.account_user_id
                  AND access.member_user_id=membership.member_user_id
                ORDER BY access.operation
              )
            END AS operations
     FROM account_memberships membership
     JOIN users owner ON owner.id=membership.account_user_id
     WHERE membership.member_user_id=$1
     ORDER BY (membership.role='owner') DESC, owner.email, membership.account_user_id`,
    [memberUserId, OPERATION_VALUES]
  );
  return result.rows;
}

function workspaceJson(row, actorUserId) {
  const propertyIds = numericArray(row.property_ids);
  const allowedByRole = row.role === 'owner'
    ? OPERATION_VALUES
    : (ROLE_ALLOWED_OPERATIONS[row.role] || []);
  const operations = textArray(row.operations).filter(operation => allowedByRole.includes(operation));
  const isOwner = row.role === 'owner' && Number(row.account_user_id) === Number(actorUserId);
  return {
    accountUserId: Number(row.account_user_id),
    accountEmail: row.account_email,
    role: row.role,
    isOwner,
    propertyIds,
    operations,
    canAccess: isOwner || (propertyIds.length > 0 && operations.length > 0)
  };
}

async function listWorkspaces(req, res, dependencies = {}) {
  const query = dependencies.query || db.query;
  const rows = await workspaceRows(req.userId, query);
  res.set('Cache-Control', 'no-store');
  res.json({ workspaces: rows.map(row => workspaceJson(row, req.userId)) });
}

function sendAccountAccessError(res, error) {
  if (!(error instanceof AccountAccessError)) return false;
  res.status(error.statusCode).json({ error: error.message, code: error.code });
  return true;
}

function requireWorkspace(operation = 'any', dependencies = {}) {
  if (operation !== 'any' && !OPERATION_VALUES.includes(operation)) {
    throw new Error(`Nghiệp vụ workspace không hợp lệ: ${operation}`);
  }
  const query = dependencies.query || db.query;
  return async function resolveWorkspace(req, res, next) {
    const actorUserId = Number(req.userId);
    let targetAccountId = actorUserId;
    const submitted = req.get(WORKSPACE_HEADER);
    if (submitted !== undefined && submitted !== null && String(submitted).trim() !== '') {
      try {
        targetAccountId = accountId(submitted);
      } catch (error) {
        if (sendAccountAccessError(res, error)) return res;
        return next(error);
      }
    }

    req.actorUserId = actorUserId;
    if (targetAccountId === actorUserId) {
      req.accountUserId = actorUserId;
      req.workspace = {
        accountUserId: actorUserId,
        actorUserId,
        role: 'owner',
        isOwner: true,
        propertyIds: null,
        operations: [...OPERATION_VALUES]
      };
      return next();
    }

    try {
      const rows = await workspaceRows(actorUserId, query);
      const workspace = rows
        .map(row => workspaceJson(row, actorUserId))
        .find(item => item.accountUserId === targetAccountId && !item.isOwner);
      if (!workspace || !workspace.canAccess) {
        throw new AccountAccessError(
          403,
          'WORKSPACE_ACCESS_DENIED',
          'Bạn chưa được cấp đủ khu và nghiệp vụ cho tài khoản này'
        );
      }
      if (operation !== 'any' && !workspace.operations.includes(operation)) {
        throw new AccountAccessError(
          403,
          'WORKSPACE_OPERATION_DENIED',
          'Bạn chưa được giao nghiệp vụ này'
        );
      }
      req.accountUserId = targetAccountId;
      req.userId = targetAccountId;
      req.workspace = {
        ...workspace,
        actorUserId,
        isOwner: false
      };
      return next();
    } catch (error) {
      if (sendAccountAccessError(res, error)) return res;
      return next(error);
    }
  };
}

module.exports = {
  AccountAccessError,
  OPERATION_VALUES,
  WORKSPACE_HEADER,
  accountId,
  listWorkspaces,
  requireWorkspace,
  sendAccountAccessError,
  workspaceJson,
  workspaceRows
};
