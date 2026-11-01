'use strict';
// Role-based access (IAM-001). Server-side only: hiding a button is never the control.
const OPS = ['platform_admin', 'service_manager', 'agent', 'engineer', 'security_analyst'];            // work tickets
const STAFF_ALL = ['platform_admin', 'service_manager', 'contract_manager', 'agent', 'engineer', 'security_analyst', 'auditor',
  'management', 'bd_manager', 'bid_manager', 'technical_team', 'sde', 'finance', 'legal', 'dept_head', 'readonly'];

const CONTRACT_VIEW = ['platform_admin', 'service_manager', 'contract_manager', 'bd_manager', 'finance', 'legal', 'management', 'dept_head', 'auditor', 'readonly'];
const TENDER_VIEW = ['platform_admin', 'service_manager', 'contract_manager', 'bd_manager', 'bid_manager', 'technical_team', 'sde', 'finance', 'legal',
  'management', 'dept_head', 'auditor', 'readonly'];
const PIPELINE_VIEW = ['platform_admin', 'service_manager', 'contract_manager', 'bd_manager', 'bid_manager', 'management', 'dept_head', 'auditor', 'readonly'];

const TICKET_VIEW = ['platform_admin', 'service_manager', 'contract_manager', 'agent', 'engineer', 'security_analyst', 'auditor', 'management', 'readonly'];
const PROJECT_VIEW = ['platform_admin', 'service_manager', 'contract_manager', 'engineer', 'sde', 'technical_team', 'bd_manager', 'management', 'dept_head', 'auditor', 'readonly'];

const GRANTS = {
  'ticket.view': TICKET_VIEW,
  'ticket.work': OPS,
  'ticket.create_for_customer': OPS,
  'ticket.assign': OPS,
  'ticket.verify': ['platform_admin', 'service_manager', 'agent', 'security_analyst'],
  'ticket.sla_note': ['platform_admin', 'service_manager'],
  'security.view': ['platform_admin', 'security_analyst'],
  'customer.view': STAFF_ALL,
  'customer.manage': ['platform_admin', 'service_manager'],
  'catalogue.manage': ['platform_admin', 'service_manager'],
  'sla.configure': ['platform_admin', 'contract_manager'],
  'engineer.assign': ['platform_admin', 'service_manager', 'contract_manager'],
  // Contracts register (CM-xxx)
  'contract.view': CONTRACT_VIEW,
  'contract.manage': ['platform_admin', 'service_manager', 'contract_manager'],
  'contract.finance': ['platform_admin', 'contract_manager', 'finance'],
  'contract.review': ['platform_admin', 'contract_manager', 'finance', 'legal', 'management', 'dept_head'],
  // Tender management (TM-xxx)
  'tender.view': TENDER_VIEW,
  'tender.manage': ['platform_admin', 'service_manager', 'contract_manager', 'bd_manager', 'bid_manager'],
  'tender.contribute': ['platform_admin', 'service_manager', 'contract_manager', 'bd_manager', 'bid_manager', 'technical_team', 'sde', 'finance', 'legal'],
  'tender.review': ['platform_admin', 'service_manager', 'management', 'dept_head', 'finance', 'technical_team', 'sde'],
  // Pipeline tracker (PT-xxx)
  'pipeline.view': PIPELINE_VIEW,
  'pipeline.manage': ['platform_admin', 'service_manager', 'contract_manager', 'bd_manager'],
  'pipeline.assign_sde': ['platform_admin', 'service_manager', 'bd_manager', 'dept_head'],
  'pipeline.support': ['platform_admin', 'sde', 'technical_team'],                       // sees only the opportunities assigned to them
  'pipeline.escalate': ['platform_admin', 'service_manager', 'contract_manager', 'bd_manager', 'dept_head'],           // flag a deal as needing leadership support
  'business.view': [...new Set([...CONTRACT_VIEW, ...TENDER_VIEW, ...PIPELINE_VIEW])],
  // Projects: delivery work. Managers run every project; team members update the tasks of projects they are on.
  'project.view': PROJECT_VIEW,
  'project.manage': ['platform_admin', 'service_manager', 'dept_head'],
  'project.contribute': ['platform_admin', 'service_manager', 'dept_head', 'engineer', 'sde', 'technical_team'],
  // Operations Overview: the weekly executive page. Anyone who may see a part of it sees that part.
  'operations.view': [...new Set([...CONTRACT_VIEW, ...TENDER_VIEW, ...PIPELINE_VIEW, ...PROJECT_VIEW, ...TICKET_VIEW])],
  'operations.manage': ['platform_admin', 'service_manager', 'dept_head'],                                          // writes the weekly highlights
  'mail.view': ['platform_admin', 'service_manager', 'security_analyst'],
  'mail.manage': ['platform_admin'],
  'user.manage': ['platform_admin'],
  'settings.manage': ['platform_admin'],
  'audit.view': ['platform_admin', 'auditor'],
  'report.view': STAFF_ALL,
};

function can(user, perm) {
  return !!user && Array.isArray(GRANTS[perm]) && GRANTS[perm].includes(user.role);
}

const ROLE_LABELS = {
  platform_admin: 'Platform administrator', service_manager: 'Service delivery manager',
  contract_manager: 'Contract / SLA manager', agent: 'Service desk agent (L1)',
  engineer: 'Specialist engineer (L2/L3)', security_analyst: 'NOC / SOC analyst', auditor: 'Auditor',
  management: 'Management / executive', bd_manager: 'Business development manager', bid_manager: 'Tender / bid manager',
  technical_team: 'Technical team member', sde: 'Service delivery engineer', finance: 'Finance team',
  legal: 'Legal / compliance', dept_head: 'Department head', readonly: 'Read-only viewer',
  customer_admin: 'Customer IT administrator', customer_user: 'Customer user',
};
const STAFF_ROLES = STAFF_ALL;
const CUSTOMER_ROLES = ['customer_admin', 'customer_user'];

/**
 * SQL condition limiting which tickets a user may see (NFR-001, CUS-006, SEC-006).
 * Pushes its parameters onto `params`. Customers can never see another customer's rows; ordinary customer users
 * see only tickets they raised. Staff without security access never see the security queue.
 */
function ticketVisibility(user, params, alias = 't') {
  if (user.kind === 'customer') {
    params.push(user.customer_id);
    let sql = `${alias}.customer_id = $${params.length}`;
    if (user.role !== 'customer_admin') {
      params.push(user.id);
      sql += ` and ${alias}.requester_id = $${params.length}`;
    }
    return sql;
  }
  return can(user, 'security.view') ? 'true' : `${alias}.queue <> 'security'`;
}

module.exports = { can, GRANTS, ROLE_LABELS, STAFF_ROLES, CUSTOMER_ROLES, ticketVisibility };
